// Live check of the dump import against the real Docker daemon and dockware/shopware (no AI, no GitHub):
// a sanitized dump (.sql or .sql.gz from mysqldump of a Dockware shop) is uploaded in chunks through the dump routes, a task with a tiny
// theme plugin imports it (version check, import, domain, plugin install, own "after-db" command, theme:compile), the storefront then
// shows the dump's data, and the dump is gone on the host and in the container. Finally the task is finished (container removed).
//
//   LOTSE_DOCKWARE_LIVE=1 LOTSE_LIVE_DUMP=/path/shop.sql.gz LOTSE_LIVE_EXPECT='Lotse Dump Shop' \
//     npx tsx --conditions=react-server tests/support/dockware-live/verify-dump.ts
//   Optional: LOTSE_DOCKWARE_IMAGE (default dockware/shopware:6.7.15.1, must be pulled), DOCKER_HOST.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { makePluginRepo } from '../plugin-repo';

if (process.env.LOTSE_DOCKWARE_LIVE !== '1' || !process.env.LOTSE_LIVE_DUMP) { console.log('Übersprungen: LOTSE_DOCKWARE_LIVE=1 und LOTSE_LIVE_DUMP setzen (startet echte Docker-Container).'); process.exit(0); }
const dumpPath = process.env.LOTSE_LIVE_DUMP, expect = process.env.LOTSE_LIVE_EXPECT ?? '';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-dump-live-'));
process.env.AICB_DATA = path.join(tmp, 'data');
for (const k of ['LOTSE_SANDBOX', 'LOTSE_SANDBOX_RUNNER', 'LOTSE_SANDBOX_NETWORK', 'AICB_DOCKER', 'LOTSE_SANDBOX_MAX', 'HOSTNAME', 'HOST', 'LOTSE_DUMP_MAX_MB']) delete process.env[k];
const repo = makePluginRepo(tmp, { theme: true, name: 'LotseDumpTheme', repo: 'acme/dump-theme' });
process.env.LOTSE_GITHUB_CLONE_BASE = `file://${repo.remoteBase}`;

const { allowFileRemotesForTests } = await import('../../../src/server/git');
const E = await import('../../../src/server/sandbox/env');
const J = await import('../../../src/server/sandbox/jobs');
const T = await import('../../../src/server/sandbox/tasks');
const D = await import('../../../src/server/sandbox/dumps');
const { getRunner } = await import('../../../src/server/sandbox/runner');
const createRoute = await import('../../../src/app/api/sandbox/dumps/route');
const chunkRoute = await import('../../../src/app/api/sandbox/dumps/[id]/route');
const completeRoute = await import('../../../src/app/api/sandbox/dumps/[id]/complete/route');
allowFileRemotesForTests(true);
E.saveSandbox({
  enabled: true, image: process.env.LOTSE_DOCKWARE_IMAGE ?? 'dockware/shopware:6.7.15.1',
  commands: [{ label: 'Shop-Name nach dem Import', command: 'mysql -N -uroot -proot -h127.0.0.1 shopware -e "SELECT configuration_value FROM system_config WHERE configuration_key = \'core.basicInformation.shopName\'" 2>/dev/null', phase: 'after-db', timeoutSec: 60 }],
});
const r = getRunner();
const until = async (fn: () => boolean, ms: number) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('Zeitüberschreitung'); await new Promise(res => setTimeout(res, 250)); } };
const sh = async (id: string, cmd: string) => (await r.exec(id, ['bash', '-lc', cmd], { user: 'www-data', workdir: '/var/www/html', timeoutMs: 60_000 })).output.trim();
const page = (origin: string, p: string) => new Promise<string>((ok, fail) => {
  http.get(new URL(p, origin), { headers: { host: 'localhost' } }, res => { const c: Buffer[] = []; res.on('data', x => c.push(x)); res.on('end', () => ok(Buffer.concat(c).toString('utf8'))); }).on('error', fail);
});

let taskId = '';
try {
  // upload in chunks through the routes (64 KB parts so even a small dump needs several)
  const data = fs.readFileSync(dumpPath), CHUNK = 64 * 1024;
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const created = await createRoute.POST(new Request('http://127.0.0.1/api/sandbox/dumps', { method: 'POST', body: JSON.stringify({ name: path.basename(dumpPath), size: data.length }) }));
  assert.equal(created.status, 201, await created.clone().text());
  const { dump } = await created.json() as { dump: { id: string } };
  let parts = 0;
  for (let o = 0; o < data.length; o += CHUNK) {
    const res = await chunkRoute.PUT(new NextRequest(`http://127.0.0.1/api/sandbox/dumps/${dump.id}?offset=${o}`, { method: 'PUT', body: data.subarray(o, o + CHUNK) }), ctx(dump.id));
    assert.equal(res.status, 200, await res.clone().text()); parts++;
  }
  const done = await completeRoute.POST(new Request('http://127.0.0.1/x', { method: 'POST', body: '{}' }), ctx(dump.id));
  assert.equal(done.status, 200, await done.clone().text());
  const hostFile = D.dumpFile(dump.id);
  assert.equal(fs.statSync(hostFile).mode & 0o777, 0o600);
  console.log(`Dump hochgeladen: ${data.length} Bytes in ${parts} Teilen.`);

  const t0 = Date.now();
  const t = T.createTask({ chatId: crypto.randomUUID(), title: 'Live-Test Dump', goal: 'Dump importieren', repo: repo.repo, baseBranch: 'main', dumpId: dump.id });
  taskId = t.id;
  J.runSteps(t.id);
  let last = '';
  await until(() => {
    const cur = T.getTask(t.id)!; const run = cur.steps.find(s => s.state === 'running');
    const line = run ? `… ${run.label ?? run.id}` : cur.status;
    if (line !== last) { console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${line}`); last = line; }
    return !J.setupRunning(t.id) && cur.status !== 'setting_up';
  }, 20 * 60_000);
  const ready = T.getTask(t.id)!;
  if (ready.status !== 'ready') { console.error(JSON.stringify(ready.steps.filter(s => s.state === 'failed'), null, 2)); throw new Error(`Status ${ready.status}: ${ready.error}`); }
  for (const s of ready.steps) console.log(`  ${s.state.padEnd(8)} ${s.label ?? s.id}${s.startedAt && s.endedAt ? ` (${((Date.parse(s.endedAt) - Date.parse(s.startedAt)) / 1000).toFixed(1)} s)` : ''}`);
  const cid = ready.containerId!;

  console.log(ready.steps.find(s => s.id === 'version-check')!.log.join('\n'));
  assert.ok(ready.steps.find(s => s.id === 'import-db')!.log.some(l => l.includes('Dump gelöscht ✓')));
  if (expect) assert.ok(ready.steps.find(s => s.label === 'Shop-Name nach dem Import')!.log.some(l => l.includes(expect)), 'after-db command ran after the import');
  assert.deepEqual({ imported: ready.dump?.imported, deleted: !!ready.dump?.deletedAt }, { imported: true, deleted: true });
  assert.ok(!fs.existsSync(hostFile), 'dump gone on the host');
  assert.equal((await D.getDump(dump.id)).status, 'deleted');
  assert.equal(await sh(cid, 'test ! -e /tmp/lotse-import && echo gone'), 'gone', 'dump gone in the container');
  assert.match(await sh(cid, 'bin/console plugin:list | grep LotseDumpTheme'), /LotseDumpTheme.*Yes.*Yes/, 'plugin installed into the imported database');
  const html = await page(await T.sandboxOrigin(ready), '/');
  if (expect) assert.ok(html.includes(expect), `storefront shows „${expect}“`);
  console.log(`Storefront zeigt „${expect}“: ${expect ? 'ja' : '(nicht geprüft)'}`);

  await J.finishTask(t.id);
  assert.equal(await r.inspect(cid), null, 'container removed');
  console.log('\nOK – alle Prüfungen bestanden.\n');
} finally {
  for (const c of await r.list({ 'lotse.task': taskId || 'none' }).catch(() => [])) await r.remove(c.id).catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
}

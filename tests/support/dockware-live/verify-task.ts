// Live check of a Sandbox Coding task against the real Docker daemon and dockware/shopware (no AI, no GitHub):
// a tiny theme plugin in a local bare repository (file:// remote, allowed for this run only) goes through the whole setup:
// container start, plugin sync + install, own commands as steps, theme:compile, then pause (docker stop) and wake
// (docker start + full sync) keep the workspace and the database, a retry of install-plugin is idempotent,
// and "Aufgabe abschließen" removes container and directories. Prints the measured timings.
//
//   LOTSE_DOCKWARE_LIVE=1 npx tsx --conditions=react-server tests/support/dockware-live/verify-task.ts
//   Optional: LOTSE_DOCKWARE_IMAGE (default dockware/shopware:6.7.15.1, must be pulled), DOCKER_HOST.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makePluginRepo } from '../plugin-repo';

if (process.env.LOTSE_DOCKWARE_LIVE !== '1') { console.log('Übersprungen: LOTSE_DOCKWARE_LIVE=1 setzen (startet echte Docker-Container).'); process.exit(0); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-dockware-live-'));
process.env.AICB_DATA = path.join(tmp, 'data');
for (const k of ['LOTSE_SANDBOX', 'LOTSE_SANDBOX_RUNNER', 'LOTSE_SANDBOX_NETWORK', 'AICB_DOCKER', 'LOTSE_SANDBOX_MAX', 'HOSTNAME', 'HOST']) delete process.env[k];
const repo = makePluginRepo(tmp, { theme: true, name: 'LotseLiveTheme', repo: 'acme/live-theme' });
process.env.LOTSE_GITHUB_CLONE_BASE = `file://${repo.remoteBase}`;

const { allowFileRemotesForTests } = await import('../../../src/server/git');
const E = await import('../../../src/server/sandbox/env');
const J = await import('../../../src/server/sandbox/jobs');
const T = await import('../../../src/server/sandbox/tasks');
const { getRunner } = await import('../../../src/server/sandbox/runner');
allowFileRemotesForTests(true);
const image = process.env.LOTSE_DOCKWARE_IMAGE ?? 'dockware/shopware:6.7.15.1';
E.saveSandbox({
  enabled: true, image,
  envVars: [{ key: 'LOTSE_LIVE_VAR', secret: false, value: 'hallo-aus-lotse' }, { key: 'LOTSE_LIVE_SECRET', secret: true, value: 'geheim-live-4711' }],
  commands: [
    { label: 'Plugin prüfen', command: 'bin/console plugin:list | grep LotseLiveTheme', phase: 'after-db', timeoutSec: 120 },
    { label: 'Variable schreiben', command: 'echo "$LOTSE_LIVE_VAR" > var/lotse-live.txt && echo "secret=$LOTSE_LIVE_SECRET"', phase: 'final', timeoutSec: 60 },
  ],
});
const r = getRunner();
const timings: Record<string, string> = {};
const secs = (a?: string, b?: string) => (a && b ? `${((Date.parse(b) - Date.parse(a)) / 1000).toFixed(1)} s` : '–');
const until = async (fn: () => boolean, ms: number) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('Zeitüberschreitung'); await new Promise(res => setTimeout(res, 250)); } };
const sh = async (id: string, cmd: string) => (await r.exec(id, ['bash', '-lc', cmd], { user: 'www-data', workdir: '/var/www/html', timeoutMs: 60_000 })).output.trim();

let taskId = '';
try {
  const t0 = Date.now();
  const t = T.createTask({ chatId: crypto.randomUUID(), title: 'Live-Test Dockware', goal: 'Setup prüfen', repo: repo.repo, baseBranch: 'main' });
  taskId = t.id;
  J.runSteps(t.id);
  let last = '';
  await until(() => {
    const cur = T.getTask(t.id)!; const run = cur.steps.find(s => s.state === 'running');
    const line = run ? `… ${run.label ?? run.id}` : cur.status;
    if (line !== last) { console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${line}`); last = line; }
    return !J.setupRunning(t.id) && cur.status !== 'setting_up';
  }, 15 * 60_000);
  const done = T.getTask(t.id)!;
  for (const s of done.steps) timings[s.label ?? s.id] = `${s.state} ${secs(s.startedAt, s.endedAt)}`;
  timings['Einrichtung gesamt'] = `${((Date.now() - t0) / 1000).toFixed(1)} s`;
  if (done.status !== 'ready') { console.error(JSON.stringify(done.steps.filter(s => s.state === 'failed'), null, 2)); throw new Error(`Status ${done.status}: ${done.error}`); }
  const cid = done.containerId!;

  // what the setup produced
  assert.equal(await sh(cid, 'cat var/lotse-live.txt'), 'hallo-aus-lotse', 'env var reached the own command');
  assert.ok(!JSON.stringify(done).includes('geheim-live-4711'), 'secret value redacted in the step log');
  assert.ok(done.steps.find(s => s.label === 'Variable schreiben')!.log.some(l => l.includes('secret=•••')));
  assert.match(await sh(cid, 'bin/console plugin:list | grep LotseLiveTheme'), /LotseLiveTheme.*Yes.*Yes/, 'installed and active');
  const dir = 'custom/plugins/LotseLiveTheme';
  assert.equal(await sh(cid, `cd ${dir} && test -f composer.json && test -L inside-link && test ! -e .env && test ! -e keys/deploy.pem && test ! -e outside-link && test ! -e .git && echo ok`), 'ok', 'only allowed files synced');
  assert.equal(await sh(cid, 'stat -c %U custom/plugins/LotseLiveTheme/composer.json'), 'www-data');
  assert.ok(Number(await sh(cid, 'grep -rl lotse-test-marker public/theme --include=*.css | wc -l')) > 0, 'theme:compile included the plugin SCSS');
  const origin = await T.sandboxOrigin(done);
  assert.equal(await T.httpStatusOf(origin, '/'), 200);
  console.log(`Storefront: ${origin} (Host: localhost) → 200`);

  // retry of install-plugin on a ready task: plugin:install must be idempotent
  let a = Date.now();
  J.runSteps(t.id, 'install-plugin');
  await until(() => !J.setupRunning(t.id), 10 * 60_000);
  assert.equal(T.getTask(t.id)!.status, 'ready', T.getTask(t.id)!.error ?? '');
  timings['Wiederholung ab „Plugin installieren“'] = `${((Date.now() - a) / 1000).toFixed(1)} s`;

  // pause keeps workspace and database; wake = start + wait + full sync
  await sh(cid, 'mysql -uroot -proot -h127.0.0.1 shopware -e "CREATE TABLE IF NOT EXISTS lotse_live (x INT); INSERT INTO lotse_live VALUES (42)" 2>/dev/null');
  fs.appendFileSync(path.join(T.taskPaths(t.id).worktree, 'README.md'), 'nach der Pause geändert\n');
  a = Date.now();
  await J.pauseTask(t.id);
  timings.Pausieren = `${((Date.now() - a) / 1000).toFixed(1)} s`;
  assert.equal((await r.inspect(cid))!.running, false);
  assert.ok(fs.existsSync(path.join(T.taskPaths(t.id).worktree, 'composer.json')), 'workspace stays');
  a = Date.now();
  await J.ensureAwake(t.id);
  timings['Fortsetzen (Start + Warten + Sync)'] = `${((Date.now() - a) / 1000).toFixed(1)} s`;
  assert.equal(T.getTask(t.id)!.status, 'ready');
  assert.equal(await sh(cid, 'mysql -N -uroot -proot -h127.0.0.1 shopware -e "SELECT x FROM lotse_live" 2>/dev/null'), '42', 'database survived the pause');
  assert.match(await sh(cid, 'tail -1 custom/plugins/LotseLiveTheme/README.md'), /nach der Pause geändert/, 'full sync after waking');
  assert.equal(await sh(cid, 'cat var/lotse-live.txt'), 'hallo-aus-lotse', 'container files survived');

  // finish: container and directories gone, record stays
  a = Date.now();
  await J.finishTask(t.id);
  timings['Abschließen'] = `${((Date.now() - a) / 1000).toFixed(1)} s`;
  assert.equal(await r.inspect(cid), null, 'container removed');
  const p = T.taskPaths(t.id);
  for (const d of [p.workspace, p.gitDir]) assert.ok(!fs.existsSync(d), d);
  assert.equal(T.getTask(t.id)!.status, 'done');
  console.log('\nOK – alle Prüfungen bestanden.\n');
  console.table(timings);
} finally {
  for (const c of await r.list({ 'lotse.task': taskId || 'none' }).catch(() => [])) await r.remove(c.id).catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
}

// Live check of a whole Shopware project with a database dump of its live shop, against the real Docker daemon and dockware/shopware
// (no AI, no GitHub): the repository (shopware/production layout) brings plugins, a static plugin, an app, a theme, src/ and production
// config; the dump comes from a shop where those plugins are installed (one of them deactivated), a composer plugin and a store plugin
// that is not in the repository are installed, the theme is assigned and plugin data exists. After the setup the sandbox must look like
// that shop: the same plugin states, theme, shop name, plugin config and plugin tables, plus the repository's new plugin installed.
//
//   LOTSE_DOCKWARE_LIVE=1 LOTSE_LIVE_REMOTE=/path/with/acme/shop.git LOTSE_LIVE_DUMP=/path/shop.sql.gz \
//     npx tsx --conditions=react-server tests/support/dockware-live/verify-project.ts
//   Without LOTSE_LIVE_DUMP the project is installed into Dockware's demo database instead.
//   Optional: LOTSE_LIVE_BRANCH (default main; a branch with .lotse/sandbox.json "projectInstall": "overlay" checks the overlay mode),
//   LOTSE_LIVE_REPO (default acme/shop), LOTSE_LIVE_EXPECT (JSON: plugin name → "<installed><active>", e.g. {"AcmeLegacy":"10"}),
//   LOTSE_LIVE_SHOP_NAME, LOTSE_DOCKWARE_IMAGE (default dockware/shopware:6.7.15.1, must be pulled), DOCKER_HOST.
//   Installed completely, the setup waits for internet: this script allows it like the click in the panel.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

if (process.env.LOTSE_DOCKWARE_LIVE !== '1' || !process.env.LOTSE_LIVE_REMOTE) {
  console.log('Übersprungen: LOTSE_DOCKWARE_LIVE=1 und LOTSE_LIVE_REMOTE setzen (startet echte Docker-Container).'); process.exit(0);
}
const dumpPath = process.env.LOTSE_LIVE_DUMP, branch = process.env.LOTSE_LIVE_BRANCH ?? 'main', repo = process.env.LOTSE_LIVE_REPO ?? 'acme/shop';
const expected = JSON.parse(process.env.LOTSE_LIVE_EXPECT ?? '{}') as Record<string, string>;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-project-live-'));
process.env.AICB_DATA = path.join(tmp, 'data');
for (const k of ['LOTSE_SANDBOX', 'LOTSE_SANDBOX_RUNNER', 'LOTSE_SANDBOX_NETWORK', 'AICB_DOCKER', 'LOTSE_SANDBOX_MAX', 'HOSTNAME', 'HOST', 'LOTSE_DUMP_MAX_MB']) delete process.env[k];
process.env.LOTSE_GITHUB_CLONE_BASE = `file://${process.env.LOTSE_LIVE_REMOTE}`;

const { allowFileRemotesForTests } = await import('../../../src/server/git');
const E = await import('../../../src/server/sandbox/env');
const J = await import('../../../src/server/sandbox/jobs');
const T = await import('../../../src/server/sandbox/tasks');
const D = await import('../../../src/server/sandbox/dumps');
const I = await import('../../../src/server/sandbox/internet');
const { getRunner } = await import('../../../src/server/sandbox/runner');
allowFileRemotesForTests(true);
E.saveSandbox({ enabled: true, image: process.env.LOTSE_DOCKWARE_IMAGE ?? 'dockware/shopware:6.7.15.1' });
const r = getRunner();
const until = async (fn: () => boolean | Promise<boolean>, ms: number) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error('Zeitüberschreitung'); await new Promise(res => setTimeout(res, 500)); } };
const sh = async (id: string, cmd: string) => (await r.exec(id, ['bash', '-lc', cmd], { user: 'www-data', workdir: '/var/www/html', timeoutMs: 120_000 })).output.trim();
const sql = (id: string, q: string) => sh(id, `mysql -N -uroot -proot -h127.0.0.1 shopware -e ${JSON.stringify(q)} 2>/dev/null`);
const page = (origin: string, p: string) => new Promise<{ body: string; headers: http.IncomingHttpHeaders; status: number }>((ok, fail) => {
  http.get(new URL(p, origin), { headers: { host: 'localhost' } }, res => { const c: Buffer[] = []; res.on('data', x => c.push(x)); res.on('end', () => ok({ body: Buffer.concat(c).toString('utf8'), headers: res.headers, status: res.statusCode ?? 0 })); }).on('error', fail);
});

let taskId = '';
try {
  let dumpId: string | undefined;
  if (dumpPath) {
    const dump = D.createDump(path.basename(dumpPath), fs.statSync(dumpPath).size);
    await D.appendChunk(dump.id, 0, fs.createReadStream(dumpPath));
    await D.completeDump(dump.id);
    dumpId = dump.id;
  }

  const t0 = Date.now();
  const t = T.createTask({ chatId: crypto.randomUUID(), title: 'Live-Test Projekt', goal: 'Projekt mit Dump einrichten', repo, baseBranch: branch, dumpId });
  taskId = t.id;
  J.runSteps(t.id);
  let last = '';
  await until(async () => {
    const cur = T.getTask(t.id)!; const run = cur.steps.find(s => s.state === 'running');
    const line = run ? `… ${run.label ?? run.id}` : cur.status;
    if (line !== last) { console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${line}`); last = line; }
    if (cur.awaitingInternet && !cur.internet) { await I.grantInternet(t.id, { via: 'panel' }); console.log('  Internet erlaubt (wie der Klick im Panel).'); }
    return !J.setupRunning(t.id) && cur.status !== 'setting_up';
  }, 60 * 60_000);
  const ready = T.getTask(t.id)!;
  for (const s of ready.steps) {
    console.log(`  ${s.state.padEnd(8)} ${s.label ?? s.id}${s.startedAt && s.endedAt ? ` (${((Date.parse(s.endedAt) - Date.parse(s.startedAt)) / 1000).toFixed(1)} s)` : ''}`);
    if (['detect-layout', 'install-plugin', 'theme-compile'].includes(s.id) || s.state === 'failed') for (const l of s.log) console.log(`      ${l}`);
  }
  if (ready.status !== 'ready') throw new Error(`Status ${ready.status}: ${ready.error}`);
  const cid = ready.containerId!;

  const states = Object.fromEntries((await sql(cid, 'SELECT name, CONCAT(installed_at IS NOT NULL, active) FROM plugin')).split('\n').map(x => x.trim().split(/\s+/)).filter(x => x.length === 2));
  console.log('Plugins in der Sandbox:', JSON.stringify(states));
  for (const [n, want] of Object.entries(expected)) assert.equal(states[n] ?? 'missing', want, `plugin ${n}`);
  const theme = await sql(cid, "SELECT t.technical_name FROM theme_sales_channel ts JOIN theme t ON t.id = ts.theme_id JOIN sales_channel sc ON sc.id = ts.sales_channel_id WHERE sc.type_id = UNHEX('8A243080F92E4C719546314B577CF82B')");
  console.log(`Theme der Storefront: ${theme}`);
  console.log(`Shop-Name: ${await sql(cid, "SELECT configuration_value FROM system_config WHERE configuration_key = 'core.basicInformation.shopName'")}`);
  console.log(`Plugin-Konfiguration AcmeLoyalty.config.pointsPerEuro: ${await sql(cid, "SELECT configuration_value FROM system_config WHERE configuration_key = 'AcmeLoyalty.config.pointsPerEuro'")}`);
  console.log(`Plugin-Tabelle acme_loyalty_points: ${await sql(cid, 'SELECT COUNT(*) FROM acme_loyalty_points').catch(e => String(e))}`);
  console.log(`Versionen: ${(await sql(cid, "SELECT name, version, IFNULL(upgrade_version, '-') FROM plugin WHERE name LIKE 'Acme%'")).replace(/\n/g, ' | ')}`);
  console.log(`Spalten acme_loyalty_points: ${(await sql(cid, 'SHOW COLUMNS FROM acme_loyalty_points').catch(e => String(e))).split('\n').map(x => x.split('\t')[0]).join(', ')}`);
  console.log(`Apps: ${await sql(cid, 'SELECT name, active FROM app')}`);
  const home = await page(await T.sandboxOrigin(ready), '/');
  console.log(`Startseite: HTTP ${home.status}, X-Acme-Project=${home.headers['x-acme-project'] ?? '–'}, X-Acme-Loyalty=${home.headers['x-acme-loyalty'] ?? '–'}, Footer des Themes: ${home.body.includes('Acme Footer') ? 'ja' : 'nein'}`);
  if (process.env.LOTSE_LIVE_SHOP_NAME) assert.ok(home.body.includes(process.env.LOTSE_LIVE_SHOP_NAME), 'storefront shows the shop name of the dump');
  assert.equal(home.status, 200);

  // a retry of the install step on the ready sandbox changes nothing (the database already knows the plugins)
  J.runSteps(t.id, 'install-plugin');
  await until(async () => {
    const cur = T.getTask(t.id)!;
    if (cur.awaitingInternet && !cur.internet) await I.grantInternet(t.id, { via: 'panel' });
    return !J.setupRunning(t.id);
  }, 30 * 60_000);
  const again = T.getTask(t.id)!;
  if (again.status !== 'ready') console.error(again.steps.filter(s => s.state === 'failed').map(s => s.log.join('\n')).join('\n'));
  assert.equal(again.status, 'ready', again.error ?? '');
  const after = Object.fromEntries((await sql(cid, 'SELECT name, CONCAT(installed_at IS NOT NULL, active) FROM plugin')).split('\n').map(x => x.trim().split(/\s+/)).filter(x => x.length === 2));
  assert.deepEqual(after, states, 'retry keeps the plugin states');

  await J.finishTask(t.id);
  console.log('\nOK – alle Prüfungen bestanden.\n');
} finally {
  for (const c of await r.list({ 'lotse.task': taskId || 'none' }).catch(() => [])) await r.remove(c.id).catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
}

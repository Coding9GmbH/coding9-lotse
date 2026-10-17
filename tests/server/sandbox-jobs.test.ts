import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import '../isolate-data';
import { makePluginRepo } from '../support/plugin-repo';
import { startFakeGithub } from '../support/github-fake';
/* eslint-disable @typescript-eslint/no-explicit-any -- loose JSON bodies in assertions */

// Setup job and lifecycle with FakeRunner and a bare file:// remote: happy path with the exact exec sequence, failure + retry,
// stop, LOTSE_SANDBOX_MAX (LRU pause / 409), pause/wake, idle sweeper, reconcile after a restart, finish/delete, redacted logs, routes.
for (const k of ['LOTSE_SANDBOX', 'LOTSE_PASSWORD', 'ALLOWED_HOSTS', 'HOSTNAME', 'HOST', 'AICB_DOCKER', 'LOTSE_BIND', 'LOTSE_SANDBOX_MAX', 'LOTSE_SANDBOX_IDLE_MINUTES', 'LOTSE_SANDBOX_NETWORK', 'LOTSE_SANDBOX_SUBNET', 'LOTSE_SANDBOX_RUNNER']) delete process.env[k];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-jobs-'));
const theme = makePluginRepo(tmp, { theme: true });
makePluginRepo(tmp, { repo: 'acme/full-shop', name: 'Unused', composer: { name: 'acme/shop', type: 'project', require: { 'shopware/core': '6.7.*' } } });
process.env.LOTSE_GITHUB_CLONE_BASE = `file://${theme.remoteBase}`;
const TOKEN = `github_pat_${'J0bsTest42'.repeat(8)}_abc`;
const gh = await startFakeGithub({ token: TOKEN, repos: [{ fullName: 'acme/shop-theme' }] });
process.env.LOTSE_GITHUB_API_BASE = gh.base;

const { FakeRunner } = await import('../../src/server/sandbox/fake-runner');
const { setRunner } = await import('../../src/server/sandbox/runner');
const { allowFileRemotesForTests } = await import('../../src/server/git');
const { saveGithub } = await import('../../src/server/github');
const E = await import('../../src/server/sandbox/env');
const J = await import('../../src/server/sandbox/jobs');
const T = await import('../../src/server/sandbox/tasks');
const R = await import('../../src/server/sandbox/reconcile');
const db = await import('../../src/server/db');
const tasksRoute = await import('../../src/app/api/sandbox/tasks/route');
const taskRoute = await import('../../src/app/api/sandbox/tasks/[id]/route');
const startRoute = await import('../../src/app/api/sandbox/tasks/[id]/start/route');
const dumpTaskRoute = await import('../../src/app/api/sandbox/tasks/[id]/dump/route');
const D = await import('../../src/server/sandbox/dumps');
const { IMPORT_ARGV } = await import('../../src/server/sandbox/templates/dockware');
const eventsRoute = await import('../../src/app/api/sandbox/tasks/[id]/events/route');

allowFileRemotesForTests(true);
saveGithub({ token: TOKEN });
const fake = new FakeRunner();
fake.images.add('dockware/shopware:6.7.15.1');
setRunner(fake);
E.saveSandbox({ enabled: true, commands: [
  { label: 'Demodaten', command: 'bin/console framework:demodata --products=5', phase: 'after-db' },
  { label: 'Abschluss', command: 'echo fertig', phase: 'final' },
] });
after(async () => { R.resetReconcile(); await fake.close(); await gh.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const until = async (fn: () => boolean, ms = 10_000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 10)); } };
const settled = (id: string) => until(() => !J.setupRunning(id) && T.getTask(id)!.status !== 'setting_up');
const execs = (id?: string) => fake.calls.filter(c => c.op === 'exec' && (!id || c.id === id)).map(c => c.argv!);
const newTask = (title = 'Footer-Farbe anpassen') => T.createTask({ title, goal: 'Der Footer soll grün werden.', repo: 'acme/shop-theme', baseBranch: 'main' });
const post = (h: (req: Request, ctx: any) => Promise<Response>, url: string, body: unknown, id?: string) =>
  h(new Request(`http://127.0.0.1${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

const DIR = '/var/www/html/custom/plugins/AcmeTheme';
const SETUP_ARGV = [
  ['mysqladmin', 'ping', '-h127.0.0.1', '-uroot', '-proot', '--silent'],
  'SET_DOMAIN',
  ['rm', '-rf', '--', DIR],
  ['bin/console', 'plugin:refresh'],
  ['bin/console', 'plugin:install', '--activate', '--', 'AcmeTheme'],
  'PLUGIN_STATE',
  ['bin/console', 'theme:change', '--all', '--no-compile', '--', 'AcmeTheme'],
  ['bash', '-lc', 'bin/console framework:demodata --products=5'],
  ['bin/console', 'theme:compile'],
  ['bin/console', 'cache:clear'],
  ['bash', '-lc', 'echo fertig'],
];

test('happy path: all steps in order, plugin synced as www-data without .git/secrets, task ready', async () => {
  const t = newTask();
  assert.match(t.id, /^t_[a-z0-9]{12}$/);
  assert.match(t.branch, new RegExp(`^lotse/footer-farbe-anpassen-${t.id.slice(2, 8)}$`));
  assert.deepEqual(t.steps.map(s => s.id).filter(s => s.includes(':')).map(s => s.split(':')[0]), ['custom-after-db', 'custom-final'], 'one step per own command');
  J.runSteps(t.id);
  await settled(t.id);
  const done = T.getTask(t.id)!;
  assert.equal(done.status, 'ready', done.error ?? '');
  assert.deepEqual(done.steps.map(s => s.state), ['done', 'done', 'done', 'done', 'done', 'skipped', 'skipped', 'done', 'done', 'done', 'done', 'done', 'done']);
  assert.deepEqual(done.layout, { kind: 'theme', name: 'AcmeTheme', pluginDir: 'custom/plugins/AcmeTheme' });
  assert.equal(done.steps.find(s => s.key === 'custom' && s.phase === 'after-db')?.label, 'Demodaten');
  const argv = execs(done.containerId!).map(a => (a[0] === 'mysql' ? (a.at(-1)!.includes('installed_at') ? 'PLUGIN_STATE' : 'SET_DOMAIN') : a));
  assert.deepEqual(argv, SETUP_ARGV);
  assert.ok(fake.calls.filter(c => c.op === 'exec').every(c => c.user === 'www-data'), 'every exec as www-data');
  // container spec: server-built, loopback port, limits, no privileges
  const spec = fake.calls.find(c => c.op === 'create')!.detail as any;
  assert.equal(spec.Labels['lotse.task'], t.id);
  assert.equal(spec.HostConfig.PortBindings['80/tcp'][0].HostIp, '127.0.0.1');
  assert.ok(!('Privileged' in spec.HostConfig) && !('Binds' in spec.HostConfig));
  // archive: only plugin files, owned by uid/gid 33
  const arch = fake.archives.find(a => a.id === done.containerId)!;
  assert.equal(arch.dir, '/var/www/html/custom/plugins');
  const paths = arch.entries.map(e => e.path);
  assert.ok(paths.includes('AcmeTheme/composer.json') && paths.includes('AcmeTheme/src/Resources/theme.json') && paths.includes('AcmeTheme/inside-link'));
  for (const bad of ['AcmeTheme/.env', 'AcmeTheme/keys/deploy.pem', 'AcmeTheme/outside-link', 'AcmeTheme/.git']) assert.ok(!paths.includes(bad), bad);
  assert.ok(arch.entries.every(e => e.uid === 33 && e.gid === 33));
  // workspace: clone with separate git dir; the worktree only has a .git file
  const p = T.taskPaths(t.id);
  assert.ok(fs.statSync(path.join(p.worktree, '.git')).isFile());
  assert.ok(fs.existsSync(path.join(p.gitDir, 'HEAD')));
  assert.ok(done.steps.every(s => s.state !== 'done' || (s.startedAt && s.endedAt)), 'durations recorded');
});

test('theme-compile fails: step failed with the SCSS tail, later steps pending; retry from it resumes without re-running earlier steps', async () => {
  fake.script = argv => (argv[1] === 'theme:compile' ? { exitCode: 1, output: 'Compiling …\nError: Undefined variable $sw-color-brand-primay\n  on line 3 of base.scss' } : undefined);
  const t = newTask('Kaputtes SCSS');
  J.runSteps(t.id);
  await settled(t.id);
  let cur = T.getTask(t.id)!;
  assert.equal(cur.status, 'failed');
  const failed = cur.steps.find(s => s.id === 'theme-compile')!;
  assert.equal(failed.state, 'failed');
  assert.match(failed.error!, /Exit-Code 1/);
  assert.match(failed.error!, /Undefined variable/);
  assert.match(cur.error!, /Undefined variable/);
  assert.deepEqual(cur.steps.slice(cur.steps.indexOf(failed) + 1).map(s => s.state), ['pending', 'pending']);

  fake.script = () => undefined;
  const before = execs(cur.containerId!).length;
  assert.throws(() => J.runSteps(t.id, 'nope'), /Unbekannter Schritt/);
  J.runSteps(t.id, 'theme-compile');
  await settled(t.id);
  cur = T.getTask(t.id)!;
  assert.equal(cur.status, 'ready');
  assert.deepEqual(execs(cur.containerId!).slice(before), [['bin/console', 'theme:compile'], ['bin/console', 'cache:clear'], ['bash', '-lc', 'echo fertig']]);
  assert.throws(() => J.runSteps(t.id), /bereits fertig/);
});

test('stop aborts the running step (interrupted), stops the container; retry continues there', async () => {
  const orig = fake.exec.bind(fake);
  fake.exec = async (id, argv, o) => {
    if (argv[2] === 'bin/console framework:demodata --products=5') await new Promise((_, fail) => o.signal?.addEventListener('abort', () => fail(new Error('Abgebrochen.')), { once: true }));
    return orig(id, argv, o);
  };
  const t = newTask('Abbrechen');
  J.runSteps(t.id);
  await until(() => T.getTask(t.id)!.steps.find(s => s.key === 'custom')?.state === 'running');
  assert.throws(() => J.runSteps(t.id), /läuft bereits/);
  await J.stopSetup(t.id);
  const cur = T.getTask(t.id)!;
  assert.equal(cur.status, 'interrupted');
  assert.equal(cur.steps.find(s => s.key === 'custom')!.state, 'interrupted');
  assert.equal(cur.containerRunning, false);
  assert.equal(fake.containers.get(cur.containerId!)!.running, false);
  fake.exec = orig;
  J.runSteps(t.id);
  await settled(t.id);
  assert.equal(T.getTask(t.id)!.status, 'ready', 'the stopped container was started again for the remaining steps');
  await J.finishTask(t.id);
});

test('LOTSE_SANDBOX_MAX: a new task pauses the least recently used ready one; with no ready one left → 409', async () => {
  for (const t of T.listTasks()) if (t.status !== 'done') await J.finishTask(t.id);
  process.env.LOTSE_SANDBOX_MAX = '1';
  try {
    const a = newTask('Erste');
    J.runSteps(a.id); await settled(a.id);
    assert.equal(T.getTask(a.id)!.status, 'ready');
    const b = newTask('Zweite');
    J.runSteps(b.id);
    assert.equal(T.getTask(a.id)!.status, 'paused', 'marked at once');
    const c = newTask('Dritte');
    assert.throws(() => J.runSteps(c.id), (e: any) => e.status === 409 && /LOTSE_SANDBOX_MAX/.test(e.message));
    await settled(b.id);
    assert.equal(T.getTask(b.id)!.status, 'ready');
    assert.equal(fake.containers.get(T.getTask(a.id)!.containerId!)!.running, false, 'paused = stopped, not removed');
    // pause / wake: docker start + full sync, no new setup
    await J.pauseTask(b.id);
    assert.equal(T.getTask(b.id)!.status, 'paused');
    const n = fake.calls.length;
    await J.startWake(a.id);
    assert.equal(T.getTask(a.id)!.status, 'waking');
    await J.ensureAwake(a.id);
    const woke = T.getTask(a.id)!;
    assert.equal(woke.status, 'ready');
    const ops = fake.calls.slice(n).filter(c => c.id === woke.containerId).map(c => c.op);
    assert.deepEqual(ops.filter(o => o !== 'inspect'), ['start', 'exec', 'exec', 'putArchive'], 'start, wait (mysqladmin), rm -rf + archive');
    assert.ok(!fake.calls.slice(n).some(c => c.op === 'create' || c.argv?.includes('plugin:install')));
    for (const t of [a, b, c]) await J.finishTask(t.id);
  } finally { delete process.env.LOTSE_SANDBOX_MAX; }
});

test('LOTSE_SANDBOX_MAX counts a failed task whose container still runs and stops that one first', async () => {
  for (const t of T.listTasks()) if (t.status !== 'done') await J.finishTask(t.id);
  process.env.LOTSE_SANDBOX_MAX = '2';
  try {
    fake.script = argv => (argv[1] === 'theme:compile' ? { exitCode: 1, output: 'Error: kaputt' } : undefined);
    const a = newTask('Fehlgeschlagen');
    J.runSteps(a.id); await settled(a.id);
    fake.script = () => undefined;
    assert.equal(T.getTask(a.id)!.status, 'failed');
    assert.equal(T.getTask(a.id)!.containerRunning, true, 'kept running for a quick retry');
    const b = newTask('Bereit');
    J.runSteps(b.id); await settled(b.id);
    const c = newTask('Neu');
    J.runSteps(c.id);
    assert.equal(T.getTask(b.id)!.status, 'ready', 'the ready task is not paused while a failed one can make room');
    await settled(c.id);
    const fa = T.getTask(a.id)!;
    assert.equal(fa.status, 'failed', 'status stays, only the container stops');
    assert.equal(fa.containerRunning, false);
    assert.equal(fake.containers.get(fa.containerId!)!.running, false);
    assert.equal(T.listTasks().filter(t => t.containerRunning).length, 2);
    for (const t of [a, b, c]) await J.finishTask(t.id);
  } finally { delete process.env.LOTSE_SANDBOX_MAX; fake.script = () => undefined; }
});

test('LOTSE_SANDBOX_MAX never pauses a task whose agent turn is running: the older idle one goes, else 409', async () => {
  for (const t of T.listTasks()) if (t.status !== 'done') await J.finishTask(t.id);
  process.env.LOTSE_SANDBOX_MAX = '2';
  try {
    const a = newTask('Agent arbeitet');
    J.runSteps(a.id); await settled(a.id);
    const b = newTask('Leerlauf');
    J.runSteps(b.id); await settled(b.id);
    const fa = T.getTask(a.id)!; fa.lastActiveAt = new Date(Date.now() - 3600_000).toISOString(); T.saveTask(fa, false); // a is the LRU one
    T.markTurn(a.id, true);
    const c = newTask('Neu');
    J.runSteps(c.id);
    assert.equal(T.getTask(a.id)!.status, 'ready', 'the busy task keeps its container');
    assert.equal(T.getTask(b.id)!.status, 'paused');
    await settled(c.id);
    T.markTurn(c.id, true);
    await assert.rejects(J.startWake(b.id), (e: any) => e.status === 409 && /LOTSE_SANDBOX_MAX/.test(e.message));
    T.markTurn(a.id, false); T.markTurn(c.id, false);
    for (const t of [a, b, c]) await J.finishTask(t.id);
  } finally { delete process.env.LOTSE_SANDBOX_MAX; }
});

test('switching off during a wake-up aborts it: paused with a stopped container, resumable afterwards', async () => {
  const t = newTask('Aufwachen abbrechen');
  J.runSteps(t.id); await settled(t.id);
  await J.pauseTask(t.id);
  const orig = fake.exec.bind(fake);
  fake.exec = async (id, argv, o) => {
    if (argv[0] === 'mysqladmin') await new Promise((_, fail) => o.signal?.addEventListener('abort', () => fail(new Error('Abgebrochen.')), { once: true }));
    return orig(id, argv, o);
  };
  try {
    await J.startWake(t.id);
    await until(() => T.getTask(t.id)!.containerRunning);
    await J.suspendAll();
    const cur = T.getTask(t.id)!;
    assert.equal(cur.status, 'paused');
    assert.equal(cur.error, null);
    assert.equal(cur.containerRunning, false);
    assert.equal(fake.containers.get(cur.containerId!)!.running, false);
  } finally { fake.exec = orig; }
  await J.ensureAwake(t.id);
  assert.equal(T.getTask(t.id)!.status, 'ready');
  await J.finishTask(t.id);
});

test('a container stopped outside Lotse: resume wakes it, the sweeper marks the task paused', async () => {
  const t = newTask('Extern gestoppt');
  J.runSteps(t.id); await settled(t.id);
  const cid = T.getTask(t.id)!.containerId!;
  await fake.stop(cid); // Docker restart, OOM kill or docker stop
  await J.ensureAwake(t.id);
  assert.equal(T.getTask(t.id)!.status, 'ready');
  assert.equal(fake.containers.get(cid)!.running, true, 'woken instead of trusting the stored flag');
  await fake.stop(cid);
  assert.deepEqual(await J.pauseIdle(Date.now()), []);
  const cur = T.getTask(t.id)!;
  assert.equal(cur.status, 'paused');
  assert.equal(cur.containerRunning, false);
  await J.finishTask(t.id);
});

test('no new setup or wake-up while the task is being finished', async () => {
  fake.script = argv => (argv[1] === 'theme:compile' ? { exitCode: 1, output: 'Error' } : undefined);
  const t = newTask('Abschluss-Rennen');
  J.runSteps(t.id); await settled(t.id);
  fake.script = () => undefined;
  const finishing = J.finishTask(t.id);
  assert.throws(() => J.runSteps(t.id), (e: any) => e.status === 409);
  await finishing;
  assert.equal(T.getTask(t.id)!.status, 'done');
  assert.equal(T.getTask(t.id)!.containerId, null);
});

test('idle sweeper pauses ready tasks after idleMinutes, not while someone watches', async () => {
  const t = newTask('Leerlauf');
  J.runSteps(t.id); await settled(t.id);
  const later = Date.now() + 31 * 60_000;
  assert.deepEqual(await J.pauseIdle(later, id => id === t.id), [], 'open task view counts as activity');
  assert.deepEqual(await J.pauseIdle(Date.now()), [], 'not idle yet');
  assert.deepEqual(await J.pauseIdle(later), [t.id]);
  const cur = T.getTask(t.id)!;
  assert.equal(cur.status, 'paused');
  assert.equal(fake.containers.get(cur.containerId!)!.running, false);
  await J.finishTask(t.id);
});

test('reconcile after a restart: running steps interrupted, orphan containers removed, container state taken over', async () => {
  const ready = newTask('Läuft weiter');
  J.runSteps(ready.id); await settled(ready.id);
  const stopped = newTask('Gestoppt');
  J.runSteps(stopped.id); await settled(stopped.id);
  await fake.stop(T.getTask(stopped.id)!.containerId!); // stopped while Lotse was down
  // a setup that was running when Lotse stopped
  const stale = newTask('Unterbrochen');
  stale.status = 'setting_up'; stale.steps[1].state = 'running'; stale.steps[0].state = 'done';
  db.codeTaskPut(stale);
  const orphan = await fake.create({ name: 'lotse-sbx-t-orphan000000', Image: 'dockware/shopware:6.7.15.1', Labels: { 'lotse.managed': '1', 'lotse.task': 't_orphan000000' } });
  assert.deepEqual(R.interruptStale(), [stale.id]);
  const s = T.getTask(stale.id)!;
  assert.equal(s.status, 'interrupted');
  assert.equal(s.steps[1].state, 'interrupted');
  const { removed } = await R.reconcileContainers();
  assert.deepEqual(removed, ['lotse-sbx-t-orphan000000']);
  assert.ok(!fake.containers.has(orphan));
  assert.equal(T.getTask(ready.id)!.status, 'ready');
  assert.equal(T.getTask(stopped.id)!.status, 'paused');
  for (const t of [ready, stopped, stale]) await J.finishTask(t.id);
});

test('finish removes container, workspace and git dir but keeps the record; delete removes the record', async () => {
  const t = newTask('Abschließen');
  J.runSteps(t.id); await settled(t.id);
  const cid = T.getTask(t.id)!.containerId!, p = T.taskPaths(t.id);
  fs.mkdirSync(p.screenshots, { recursive: true });
  await J.finishTask(t.id);
  const done = T.getTask(t.id)!;
  assert.equal(done.status, 'done');
  assert.equal(done.containerId, null);
  assert.ok(!fake.containers.has(cid));
  for (const d of [p.workspace, p.gitDir, p.screenshots]) assert.ok(!fs.existsSync(d), d);
  assert.throws(() => J.runSteps(t.id), /abgeschlossen/);
  await J.deleteTask(t.id);
  assert.equal(T.getTask(t.id), null);
});

test('logs are redacted before they are stored or streamed', async () => {
  const leak = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
  fake.script = argv => (argv[2] === 'echo fertig' ? { output: `token=${leak}\nfertig` } : undefined);
  const t = newTask('Geheimnis');
  const seen: string[] = [];
  const off = T.listen(t.id, ev => { if (ev.t === 'log') seen.push(ev.line); });
  J.runSteps(t.id); await settled(t.id);
  off(); fake.script = () => undefined;
  const stored = JSON.stringify(T.getTask(t.id));
  assert.ok(!stored.includes(leak) && !seen.join('\n').includes(leak));
  assert.ok(seen.some(l => l.includes('ghp_•••')));
  await J.finishTask(t.id);
});

test('detect-layout: a full Shopware project stops with a clear German error', async () => {
  const t = T.createTask({ title: 'Ganzer Shop', goal: '', repo: 'acme/full-shop', baseBranch: 'main' });
  J.runSteps(t.id); await settled(t.id);
  const cur = T.getTask(t.id)!;
  assert.equal(cur.status, 'failed');
  assert.match(cur.error!, /Vollständige Shopware-Projekte werden von dieser Vorlage noch nicht unterstützt/);
  assert.equal(cur.containerId, null, 'no container before the layout is known');
  await J.deleteTask(t.id);
});

// ---- Database dump: version check, import, deletion ----
const dumpSql = (minor: number) => Buffer.from(`-- MySQL dump\nINSERT INTO \`migration\` VALUES ('Shopware\\\\Core\\\\Migration\\\\V6_${minor}\\\\Migration1700000000Foo',1,NULL,NULL,NULL);\nINSERT INTO \`system_config\` VALUES ('x');\n`);
async function readyDump(minor = 7) {
  const data = dumpSql(minor), d = D.createDump('shop.sql', data.length);
  await D.appendChunk(d.id, 0, Readable.from([data]));
  return D.completeDump(d.id);
}
const IMPORT_DIR = '/tmp/lotse-import';
const fakeFiles = (cid: string) => [...fake.containers.get(cid)!.files.keys()];

test('dump: streamed into the container as www-data (0600), exact constant import argv, deleted on host and in the container', async () => {
  fake.script = argv => (argv[1] === '--version' ? { output: 'Shopware 6.7.15.1 (env: dev, debug: true)' } : undefined);
  const dump = await readyDump(7);
  const t = T.createTask({ title: 'Mit Dump', goal: '', repo: 'acme/shop-theme', baseBranch: 'main', dumpId: dump.id });
  J.runSteps(t.id); await settled(t.id);
  const done = T.getTask(t.id)!;
  assert.equal(done.status, 'ready', done.error ?? '');
  const states = Object.fromEntries(done.steps.map(s => [s.id, s.state]));
  assert.equal(states['version-check'], 'done'); assert.equal(states['import-db'], 'done');
  const cid = done.containerId!, argv = execs(cid);
  // order: import before domain, plugin install and the own after-db command; theme:compile afterwards
  const at = (pred: (a: string[]) => boolean) => argv.findIndex(pred);
  const imp = at(a => a[0] === 'bash' && a[1] === '-c');
  assert.deepEqual(argv[imp], IMPORT_ARGV);
  assert.deepEqual(IMPORT_ARGV, ['bash', '-c', 'set -o pipefail; gunzip -cf /tmp/lotse-import/dump | mysql -uroot -proot -h127.0.0.1 shopware; rc=$?; rm -rf /tmp/lotse-import; exit $rc']);
  assert.ok(imp < at(a => a[0] === 'mysql' && a.at(-1)!.includes('sales_channel_domain')) && imp < at(a => a[1] === 'plugin:install') && at(a => a[1] === 'plugin:install') < at(a => a[2] === 'bin/console framework:demodata --products=5') && at(a => a[2]?.includes('demodata')) < at(a => a[1] === 'theme:compile'));
  const arch = fake.archives.find(a => a.id === cid && a.dir === '/tmp')!;
  assert.deepEqual(arch.entries.map(e => [e.path, e.type, e.uid, e.gid, e.mode]), [['lotse-import', 'dir', 33, 33, 0o700], ['lotse-import/dump', 'file', 33, 33, 0o600]]);
  assert.deepEqual(arch.entries[1].data, dumpSql(7));
  assert.ok(!fakeFiles(cid).some(f => f.startsWith(IMPORT_DIR)), 'removed in the container');
  assert.ok(!fs.existsSync(D.dumpFile(dump.id)), 'removed on the host');
  assert.equal(db.codeDumpGet(dump.id)!.status, 'deleted');
  assert.deepEqual(T.publicTask(done).dump, { name: 'shop.sql', size: dumpSql(7).length, sha256: dump.sha256, imported: true, deleted: true, ignoreVersion: false });
  assert.ok(done.steps.find(s => s.id === 'import-db')!.log.includes('Datenbank importiert. Dump gelöscht ✓'));
  fake.script = () => undefined;
  await J.finishTask(t.id);
});

test('dump: a failed import deletes the dump too; a retry asks for a new upload', async () => {
  fake.script = argv => (argv[0] === 'bash' && argv[1] === '-c' ? { exitCode: 1, output: 'ERROR 1064 (42000) at line 2: syntax error' } : undefined);
  const dump = await readyDump(7);
  const t = T.createTask({ title: 'Kaputter Dump', goal: '', repo: 'acme/shop-theme', baseBranch: 'main', dumpId: dump.id });
  J.runSteps(t.id); await settled(t.id);
  let cur = T.getTask(t.id)!;
  assert.equal(cur.status, 'failed');
  assert.match(cur.steps.find(s => s.id === 'import-db')!.error!, /ERROR 1064/);
  assert.ok(!fs.existsSync(D.dumpFile(dump.id)));
  assert.ok(!fakeFiles(cur.containerId!).some(f => f.startsWith(IMPORT_DIR)));
  assert.ok(execs(cur.containerId!).some(a => a.join(' ') === `rm -rf -- ${IMPORT_DIR}`), 'cleanup in the container');
  assert.deepEqual({ imported: cur.dump!.imported, deleted: !!cur.dump!.deletedAt }, { imported: false, deleted: true });
  fake.script = () => undefined;
  J.runSteps(t.id, 'import-db'); await settled(t.id);
  cur = T.getTask(t.id)!;
  assert.match(cur.steps.find(s => s.id === 'import-db')!.error!, /erneut hochladen/);
  // "Datenbank ersetzen" with a new dump works
  const again = await readyDump(7);
  const res = await post(dumpTaskRoute.POST, `/api/sandbox/tasks/${t.id}/dump`, { dumpId: again.id }, t.id);
  assert.equal(res.status, 202);
  await settled(t.id);
  cur = T.getTask(t.id)!;
  assert.equal(cur.status, 'ready', cur.error ?? '');
  assert.equal(cur.dump!.imported, true);
  await J.finishTask(t.id);
});

test('dump: a different Shopware minor version blocks until "Trotzdem fortfahren"; the dump waits meanwhile', async () => {
  fake.script = argv => (argv[1] === '--version' ? { output: 'Shopware 6.7.15.1 (env: dev, debug: true)' } : undefined);
  const dump = await readyDump(6);
  const t = T.createTask({ title: 'Alte Version', goal: '', repo: 'acme/shop-theme', baseBranch: 'main', dumpId: dump.id });
  J.runSteps(t.id); await settled(t.id);
  let cur = T.getTask(t.id)!;
  assert.equal(cur.status, 'failed');
  assert.equal(cur.steps.find(s => s.id === 'version-check')!.state, 'failed');
  assert.match(cur.error!, /Dump stammt von 6\.6, Image enthält 6\.7\.15\.1/);
  assert.deepEqual(T.publicTask(cur).dump!.versionMismatch, { dump: '6.6', image: '6.7.15.1' });
  assert.ok(fs.existsSync(D.dumpFile(dump.id)), 'kept for the decision');
  assert.ok(!execs(cur.containerId!).some(a => a[0] === 'bash' && a[1] === '-c'), 'nothing imported');
  // "Datenbank ersetzen" that cannot start (409 capacity, 400 unknown step) keeps the waiting dump and leaves the new one free
  const other = newTask('Belegt'); other.status = 'setting_up'; T.saveTask(other, false);
  process.env.LOTSE_SANDBOX_MAX = '1';
  const next = await readyDump(7);
  try { assert.throws(() => J.runSteps(t.id, undefined, { dumpId: next.id }), (e: any) => e.status === 409); } finally { delete process.env.LOTSE_SANDBOX_MAX; db.codeTaskDelete(other.id); }
  const old = T.getTask(t.id)!; old.steps = old.steps.filter(s => s.id !== 'version-check'); T.saveTask(old, false);
  assert.throws(() => J.runSteps(t.id, undefined, { dumpId: next.id }), (e: any) => e.status === 400);
  T.saveTask(cur, false);
  assert.equal(T.getTask(t.id)!.dump!.id, dump.id);
  assert.ok(fs.existsSync(D.dumpFile(dump.id)), 'waiting dump kept');
  assert.equal(db.codeDumpGet(next.id)!.taskId, null, 'new dump not bound');
  D.deleteDump(next.id);
  // a plain retry blocks again
  J.runSteps(t.id, 'version-check'); await settled(t.id);
  assert.equal(T.getTask(t.id)!.status, 'failed');
  const res = await post(startRoute.POST, `/api/sandbox/tasks/${t.id}/start`, { fromStep: 'version-check', ignoreVersion: true }, t.id);
  assert.equal(res.status, 202);
  await settled(t.id);
  cur = T.getTask(t.id)!;
  assert.equal(cur.status, 'ready', cur.error ?? '');
  assert.equal(cur.dump!.imported, true);
  assert.ok(!fs.existsSync(D.dumpFile(dump.id)));
  fake.script = () => undefined;
  await J.finishTask(t.id);
});

test('dump: finishing a task deletes a dump that was not imported yet; a dump cannot belong to two tasks', async () => {
  fake.script = argv => (argv[1] === '--version' ? { output: 'Shopware 6.7.15.1' } : undefined);
  const dump = await readyDump(6);
  const t = T.createTask({ title: 'Wartender Dump', goal: '', repo: 'acme/shop-theme', baseBranch: 'main', dumpId: dump.id });
  assert.throws(() => T.createTask({ title: 'Zweite', goal: '', repo: 'acme/shop-theme', baseBranch: 'main', dumpId: dump.id }), /anderen Aufgabe/);
  J.runSteps(t.id); await settled(t.id);
  assert.ok(fs.existsSync(D.dumpFile(dump.id)));
  await J.finishTask(t.id);
  assert.ok(!fs.existsSync(D.dumpFile(dump.id)));
  assert.equal(db.codeDumpGet(dump.id)!.status, 'deleted');
  assert.ok(T.getTask(t.id)!.dump!.deletedAt);
  fake.script = () => undefined;
});

test('routes: 403 while off, create checks repository access, start/events, switching off pauses tasks', async () => {
  const created = await post(tasksRoute.POST, '/api/sandbox/tasks', { title: 'Über Route', goal: 'x', repo: 'acme/shop-theme', baseBranch: 'main' });
  assert.equal(created.status, 201);
  const { task } = await created.json() as any;
  assert.equal(task.status, 'setting_up');
  assert.ok(!JSON.stringify(task).includes('framework:demodata'), 'stored commands are not sent to the browser');
  const denied = await post(tasksRoute.POST, '/api/sandbox/tasks', { title: 'Fremd', repo: 'other/repo', baseBranch: 'main' });
  assert.equal(denied.status, 400);
  assert.match((await denied.json() as any).error, /Kein Zugriff auf other\/repo/);
  assert.equal((await post(tasksRoute.POST, '/api/sandbox/tasks', { title: 'X', repo: 'acme/shop-theme', baseBranch: '-x' })).status, 400);
  await settled(task.id);
  const conflict = await post(startRoute.POST, `/api/sandbox/tasks/${task.id}/start`, {}, task.id);
  assert.equal(conflict.status, 409);
  // events: snapshot first
  const ac = new AbortController();
  const ev = await eventsRoute.GET(new Request(`http://127.0.0.1/api/sandbox/tasks/${task.id}/events`, { signal: ac.signal }), { params: Promise.resolve({ id: task.id }) });
  const reader = ev.body!.getReader();
  const first = JSON.parse(new TextDecoder().decode((await reader.read()).value).split('\n')[0]);
  assert.equal(first.t, 'task'); assert.equal(first.task.status, 'ready');
  ac.abort(); await reader.cancel();
  assert.ok(db.auditList().some(a => (a as any).kind === 'sandbox-task' && (a as any).action === 'create'));
  // switched off: running containers stopped, tasks paused; routes answer 403
  await J.suspendAll();
  assert.equal(T.getTask(task.id)!.status, 'paused');
  E.saveSandbox({ enabled: false });
  const off = await tasksRoute.GET(new Request('http://127.0.0.1/api/sandbox/tasks'));
  assert.equal(off.status, 403);
  assert.equal((await off.json() as any).reason, 'off');
  E.saveSandbox({ enabled: true });
  const del = await taskRoute.DELETE(new Request(`http://127.0.0.1/api/sandbox/tasks/${task.id}`, { method: 'DELETE' }), { params: Promise.resolve({ id: task.id }) });
  assert.equal(del.status, 200);
  assert.equal(T.getTask(task.id), null);
});

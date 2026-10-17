import crypto from 'node:crypto';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import '../isolate-data';
import { sandboxForTests } from '../support/sandbox-task';
/* eslint-disable @typescript-eslint/no-explicit-any -- container specs as loose JSON */

// Before/after screenshots (plan PR 8) with the FakeRunner: the spec builder (only the task's sandbox alias and validated paths,
// no mounts, no ports), the capture as a setup step and at publishing, fixture PNGs, the image route, and that a failure never
// blocks the setup or publishing.
const S = await sandboxForTests();
const { fake, gh, J, T, E } = S;
const SS = await import('../../src/server/sandbox/screenshot-spec');
const SH = await import('../../src/server/sandbox/screenshots');
const P = await import('../../src/server/sandbox/publish');
const { FAKE_PNG } = await import('../../src/server/sandbox/fake-runner');
const { assertSafeSpec } = await import('../../src/server/sandbox/guards');
const { withActor } = await import('../../src/server/actor');
const D = await import('../../src/server/sandbox/dumps');
const { getTemplate } = await import('../../src/server/sandbox/templates');
const route = await import('../../src/app/api/sandbox/tasks/[id]/screenshots/[file]/route');
after(S.close);

const HEADER = 'src/Resources/views/storefront/layout/header/header.html.twig';
const shotSpecs = () => fake.calls.filter(c => c.op === 'create' && (c.detail as any).Image === SS.SCREENSHOT_IMAGE).map(c => c.detail as any);
const write = (id: string, text: string) => { const f = path.join(T.taskPaths(id).worktree, HEADER); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const get = (id: string, file: string) => route.GET(new Request(`http://127.0.0.1/api/sandbox/tasks/${id}/screenshots/${file}`), { params: Promise.resolve({ id, file }) });
const prBodies = () => gh.calls.filter(c => c.path.endsWith('/pulls') || /\/pulls\/\d+$/.test(c.path)).filter(c => c.method !== 'GET').map(c => String((c.body as { body?: string }).body ?? ''));

test('spec builder: pinned image, internal network only, no mounts/ports, non-root, every capability dropped; job only for the own sandbox', () => {
  const spec = SS.buildShotSpec('t_abcdefghijkl') as any;
  assert.equal(spec.Image, 'mcr.microsoft.com/playwright:v1.64.0-noble');
  assert.equal(spec.name, 'lotse-shot-t-abcdefghijkl');
  assert.deepEqual(spec.Cmd, ['node', '/lotse/shot.mjs']);
  assert.equal(spec.User, 'pwuser');
  assert.equal(spec.HostConfig.NetworkMode, 'lotse-sandbox');
  assert.deepEqual(spec.HostConfig.CapDrop, ['ALL']);
  assert.deepEqual(spec.HostConfig.SecurityOpt, ['no-new-privileges:true']);
  for (const k of ['Binds', 'Mounts', 'PortBindings', 'Privileged', 'Devices']) assert.ok(!(k in spec.HostConfig), k);
  assert.ok(!('ExposedPorts' in spec) && !('Env' in spec) && !('NetworkingConfig' in spec));
  assert.deepEqual(spec.Labels, { 'lotse.managed': '1', 'lotse.task': 't_abcdefghijkl', 'lotse.role': 'screenshot' });
  assert.doesNotThrow(() => assertSafeSpec(spec));
  assert.throws(() => SS.buildShotSpec('../x'), /Aufgaben-ID/);

  const job = SS.buildShotJob('t_abcdefghijkl', ['/', '/checkout/cart', '/']);
  assert.equal(job.proxy, 'http://lotse-sbx-t-abcdefghijkl:80', 'the browser reaches only its own sandbox');
  assert.deepEqual(job.shots.map(s => [s.file, s.url, s.width]), [['1-desktop.png', 'http://localhost/', 1366], ['1-mobile.png', 'http://localhost/', 390], ['2-desktop.png', 'http://localhost/checkout/cart', 1366], ['2-mobile.png', 'http://localhost/checkout/cart', 390]]);
  assert.ok(job.shots.every(s => new URL(s.url).host === 'localhost'));
  assert.match(job.shots[1].userAgent!, /iPhone/);
  for (const bad of ['http://evil.example/', '//evil.example/', '/../etc/passwd', '/a b', '/x#y', 'relative', '/a/..', '/a\\b', "/x'y", '/x"y'])
    assert.throws(() => SS.validShotPath(bad), /Ungültiger Pfad/, bad);
  assert.equal(SS.validShotPath(' /detail/abc?x=1&y=2 '), '/detail/abc?x=1&y=2');
  assert.throws(() => SS.validShotPaths(['/a', '/b', '/c', '/d', '/e', '/f']), /Höchstens 5/);
  assert.throws(() => SS.buildShotJob('t_abcdefghijkl', []), /Keine Seiten/);
  // the script takes everything from job.json: no task data is interpolated into it
  assert.ok(!SS.SHOT_SCRIPT.includes('lotse-sbx') && SS.SHOT_SCRIPT.includes("spawn(bin, args"));
});

test('environment: screenshot pages validated (default "/"), at most 5; empty = no screenshots', () => {
  assert.deepEqual(E.sandboxPublic().screenshotPaths, ['/']);
  assert.throws(() => E.saveSandbox({ screenshotPaths: ['http://evil/'] }), /Ungültiger Pfad/);
  assert.deepEqual(E.saveSandbox({ screenshotPaths: ['/', ' /checkout/cart ', '/'] }).changed, ['screenshotPaths']);
  assert.deepEqual(E.sandboxPublic().screenshotPaths, ['/', '/checkout/cart']);
  E.saveSandbox({ screenshotPaths: ['/'] });
});

let task: Awaited<ReturnType<typeof S.readyTask>>;
test('setup: before screenshots after theme:compile, via putArchive/wait/getArchive; the screenshot container is removed again', async () => {
  task = await S.readyTask('Screenshots');
  const steps = task.steps.map(s => s.key);
  assert.deepEqual(steps.slice(steps.indexOf('theme-compile')), ['theme-compile', 'screenshots', 'ready']);
  assert.equal(task.steps.find(s => s.key === 'screenshots')!.state, 'done');
  const before = task.shots!.before!;
  assert.deepEqual(before.items, [{ path: '/', device: 'desktop', file: 'before-1-desktop.png' }, { path: '/', device: 'mobile', file: 'before-1-mobile.png' }]);
  assert.equal(before.error, undefined);
  const dir = T.taskPaths(task.id).screenshots;
  assert.ok(fs.readFileSync(path.join(dir, 'before-1-desktop.png')).equals(FAKE_PNG));
  // the archive with script and job, owned by the non-root user; the container is gone afterwards
  const shotId = fake.calls.filter(c => c.op === 'putArchive' && c.detail === '/').at(-1)!.id!;
  const arch = fake.archives.find(a => a.id === shotId)!;
  assert.deepEqual(arch.entries.map(e => [e.path, e.uid]), [['lotse', 1001], ['lotse/out', 1001], ['lotse/shot.mjs', 1001], ['lotse/job.json', 1001]]);
  assert.equal(JSON.parse(arch.entries[3].data.toString()).proxy, `http://lotse-sbx-${task.id.replace(/_/g, '-')}:80`);
  const ops = fake.calls.filter(c => c.id === shotId).map(c => c.op);
  assert.deepEqual(ops.filter(o => o !== 'inspect'), ['putArchive', 'start', 'wait', 'getArchive', 'remove']);
  assert.ok(!fake.containers.has(shotId), 'removed');
  assert.ok(shotSpecs().every(s => s.HostConfig.NetworkMode === 'lotse-sandbox'));
  assert.ok(fake.images.has(SS.SCREENSHOT_IMAGE), 'pulled during the setup');
  // public: urls of the image route only
  const pub = T.publicTask(T.getTask(task.id)!);
  assert.match(pub.shots.before!.shots[0].url, new RegExp(`^/api/sandbox/tasks/${task.id}/screenshots/before-1-desktop\\.png\\?v=\\d+$`));
  assert.equal(pub.shots.after, null);
});

test('image route: the listed PNG with nosniff; anything else 404', async () => {
  const r = await get(task.id, 'before-1-desktop.png');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(FAKE_PNG));
  fs.writeFileSync(path.join(T.taskPaths(task.id).screenshots, 'after-1-desktop.png'), FAKE_PNG);
  for (const f of ['after-1-desktop.png', '..%2F..%2Fsettings.json', '../x.png', 'before-9-desktop.png', 'before-1-desktop.png.bak']) assert.equal((await get(task.id, f)).status, 404, f);
  fs.rmSync(path.join(T.taskPaths(task.id).screenshots, 'after-1-desktop.png'));
});

test('publish: after screenshots before the commit, the PR body mentions them without a link; nothing uploaded', async () => {
  write(task.id, "{% sw_extends '@Storefront/storefront/layout/header/header.html.twig' %}\n{% block layout_header %}<div>Gratis Versand</div>{{ parent() }}{% endblock %}\n");
  const r = await withActor('alex', () => P.publishTask(task.id, { title: 'Header', body: 'Geprüft.' }));
  assert.equal(r.action, 'created');
  const t = T.getTask(task.id)!;
  assert.deepEqual(t.shots!.after!.items.map(i => i.file), ['after-1-desktop.png', 'after-1-mobile.png']);
  assert.equal((await get(task.id, 'after-1-mobile.png')).status, 200);
  const body = prBodies().at(-1)!;
  assert.match(body, /\*\*Screenshots:\*\* Vorher-\/Nachher-Screenshots der Sandbox-Storefront \(Desktop und Mobil; `\/`\) liegen in Lotse/);
  assert.ok(!/https?:\/\/|\/api\/sandbox|!\[/.test(body.split('---')[0]), 'no link, no image');
  assert.ok(!gh.calls.some(c => /upload|contents|assets/.test(c.path)), 'nothing uploaded to GitHub');
});

test('a failing capture never blocks: partial set with reason; a failed after set keeps publishing working', async () => {
  // partial: mobile fails
  fake.shooter = job => Object.fromEntries(job.shots.map(s => [s.file, s.file.includes('mobile') ? null : FAKE_PNG]));
  const set = await SH.captureAfter(task.id);
  assert.deepEqual(set!.items.map(i => i.device), ['desktop']);
  assert.match(set!.error!, /1 von 2 Aufnahmen fehlen – \/ \(mobile\): Exit 1: net::ERR_CONNECTION_REFUSED/);
  assert.ok(!fs.existsSync(path.join(T.taskPaths(task.id).screenshots, 'after-1-mobile.png')), 'the old mobile after shot is gone');
  // nothing at all (no PNG, or not a PNG): publishing still works, the body only mentions the before screenshots
  fake.shooter = job => Object.fromEntries(job.shots.map(s => [s.file, Buffer.from('<html>not a png</html>')]));
  write(task.id, "{% sw_extends '@Storefront/storefront/layout/header/header.html.twig' %}\n{% block layout_header %}<div>Gratis Versand ab 50 €</div>{{ parent() }}{% endblock %}\n");
  const r = await withActor('alex', () => P.publishTask(task.id, { title: 'Header', body: 'Geprüft.' }));
  assert.equal(r.action, 'updated');
  const t = T.getTask(task.id)!;
  assert.deepEqual(t.shots!.after!.items, []);
  assert.match(t.shots!.after!.error!, /Keine Screenshots entstanden: \/ \(desktop\): kein gültiges PNG/);
  assert.match(prBodies().at(-1)!, /\*\*Screenshots:\*\* Vorher-Screenshots der Sandbox-Storefront/);
  assert.equal([...fake.containers.values()].filter(c => c.spec.Labels['lotse.role'] === 'screenshot').length, 0, 'every screenshot container removed');
  fake.shooter = null;
});

test('paused sandbox: no after screenshots (reason stored), publishing works; Docker refusing the container is no blocker either', async () => {
  await J.pauseTask(task.id);
  write(task.id, "{% block layout_header %}<div>Pausiert</div>{% endblock %}\n");
  await withActor('alex', () => P.publishTask(task.id, { title: 'Header', body: 'x' }));
  assert.match(T.getTask(task.id)!.shots!.after!.error!, /nicht bereit \(pausiert oder gestoppt\)/);
  await J.ensureAwake(task.id);
  fake.failNext = { op: 'getArchive', message: 'Dateien abholen: Docker meldet HTTP 500' };
  const set = await SH.captureAfter(task.id);
  assert.match(set!.error!, /HTTP 500/);
  assert.equal([...fake.containers.values()].filter(c => c.spec.Labels['lotse.role'] === 'screenshot').length, 0, 'removed after the failure too');
});

test('before screenshots: kept on a re-run, taken again after a new clone; a failure only skips the step; none without pages', async () => {
  const shots = () => fake.calls.filter(c => c.op === 'create' && (c.detail as any).Image === SS.SCREENSHOT_IMAGE).length;
  let n = shots();
  J.runSteps(task.id, 'theme-compile');
  await S.until(() => !J.setupRunning(task.id));
  assert.equal(shots(), n, 'existing before screenshots are kept');
  assert.match(T.getTask(task.id)!.steps.find(s => s.key === 'screenshots')!.log.join('\n'), /schon vorhanden/);

  fake.shooter = () => { throw new Error('boom'); };
  J.runSteps(task.id, 'clone');
  await S.until(() => !J.setupRunning(task.id));
  let t = T.getTask(task.id)!;
  assert.equal(t.status, 'ready', t.error ?? '');
  assert.equal(t.steps.find(s => s.key === 'screenshots')!.state, 'skipped');
  assert.deepEqual(t.shots!.before!.items, []);
  assert.match(t.shots!.before!.error!, /Exit-Code 1/);
  assert.equal(t.shots!.after, undefined, 'a fresh clone drops the old after screenshots');
  assert.ok(!fs.existsSync(path.join(T.taskPaths(task.id).screenshots, 'before-1-desktop.png')));
  fake.shooter = null;

  E.saveSandbox({ screenshotPaths: [] });
  n = shots();
  J.runSteps(task.id, 'screenshots');
  await S.until(() => !J.setupRunning(task.id));
  t = T.getTask(task.id)!;
  assert.equal(t.steps.find(s => s.key === 'screenshots')!.state, 'skipped');
  assert.equal(await SH.captureAfter(task.id), null);
  assert.equal(shots(), n, 'no screenshot container without pages');
  E.saveSandbox({ screenshotPaths: ['/'] });
});

test('the step time limit (e.g. a slow image pull) only skips the before screenshots; the setup still ends ready', async () => {
  const def = getTemplate(task.template).steps.find(s => s.id === 'screenshots')!, limit = def.timeoutMs, pull = fake.ensureImage;
  def.timeoutMs = 50;
  // the limit may already be over when the pull starts (a slow machine): then it fails at once
  fake.ensureImage = (_image: string, _progress?: unknown, signal?: AbortSignal) => new Promise<{ pulled: boolean }>((_, no) => {
    const stop = () => no(new Error('Abbruch beim Laden'));
    if (signal!.aborted) stop(); else signal!.addEventListener('abort', stop, { once: true });
  });
  try {
    J.runSteps(task.id, 'screenshots');
    await S.until(() => !J.setupRunning(task.id));
  } finally { def.timeoutMs = limit; fake.ensureImage = pull; }
  const t = T.getTask(task.id)!;
  assert.equal(t.status, 'ready', t.error ?? '');
  assert.equal(t.steps.find(s => s.key === 'screenshots')!.state, 'skipped');
  assert.match(t.shots!.before!.error!, /Abbruch beim Laden/);
});

test('"Datenbank ersetzen" after edits: no new before screenshots of the changed code (empty set with reason)', async () => {
  J.runSteps(task.id, 'screenshots');
  await S.until(() => !J.setupRunning(task.id));
  assert.equal(T.getTask(task.id)!.shots!.before!.items.length, 2, 'unchanged code: taken');
  write(task.id, "{% block layout_header %}<div>Neu</div>{% endblock %}\n");
  fake.script = argv => (argv[1] === '--version' ? { output: 'Shopware 6.7.15.1 (env: dev, debug: true)' } : undefined);
  const data = Buffer.from("-- MySQL dump\nINSERT INTO `migration` VALUES ('Shopware\\\\Core\\\\Migration\\\\V6_7\\\\Migration1700000000Foo',1,NULL,NULL,NULL);\n");
  const d = D.createDump('shop.sql', data.length);
  await D.appendChunk(d.id, 0, Readable.from([data]));
  J.runSteps(task.id, undefined, { dumpId: (await D.completeDump(d.id)).id });
  await S.until(() => !J.setupRunning(task.id));
  fake.script = () => undefined;
  const t = T.getTask(task.id)!;
  assert.equal(t.status, 'ready', t.error ?? '');
  assert.equal(t.steps.find(s => s.key === 'import-db')!.state, 'done');
  assert.equal(t.steps.find(s => s.key === 'screenshots')!.state, 'skipped');
  assert.deepEqual(t.shots!.before!.items, []);
  assert.match(t.shots!.before!.error!, /schon geändert/);
  assert.ok(!fs.existsSync(path.join(T.taskPaths(task.id).screenshots, 'before-1-desktop.png')));
});

test('a running publish keeps its container: neither the idle sweeper nor another setup stops it', async () => {
  let release!: () => void;
  T.markPublishing(task.id, new Promise<void>(r => { release = r; }));
  try {
    assert.deepEqual(await J.pauseIdle(Date.now() + 365 * 24 * 3600_000), []);
    process.env.LOTSE_SANDBOX_MAX = '1';
    const other = T.createTask({ chatId: crypto.randomUUID(), title: 'Zweite', goal: '', repo: 'acme/shop-theme', baseBranch: 'main' });
    assert.throws(() => J.runSteps(other.id), (e: any) => e.status === 409);
    await J.deleteTask(other.id);
  } finally { delete process.env.LOTSE_SANDBOX_MAX; release(); await T.publishSettled(task.id); }
  assert.equal(T.getTask(task.id)!.status, 'ready');
});

test('finish removes the screenshots with the task; the finished task lists none', async () => {
  J.runSteps(task.id, 'clone');
  await S.until(() => !J.setupRunning(task.id));
  assert.ok(fs.existsSync(path.join(T.taskPaths(task.id).screenshots, 'before-1-desktop.png')));
  await J.finishTask(task.id);
  assert.ok(!fs.existsSync(T.taskPaths(task.id).screenshots));
  assert.deepEqual(T.publicTask(T.getTask(task.id)!).shots, { before: null, after: null });
});

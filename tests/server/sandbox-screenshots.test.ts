import crypto from 'node:crypto';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import '../isolate-data';
import { sandboxForTests } from '../support/sandbox-task';
/* eslint-disable @typescript-eslint/no-explicit-any -- container specs as loose JSON */

// Screenshots (plan PR 8, simplified by A14) with the FakeRunner: the spec builder (only the task's sandbox alias and validated paths,
// no mounts, no ports); neither the setup nor publishing takes any by default; the manual "Screenshot" of the preview (only while
// switched on in the environment), fixture PNGs, the image route, and that a failed capture stores nothing.
const S = await sandboxForTests();
const { fake, gh, J, T, E } = S;
const SS = await import('../../src/server/sandbox/screenshot-spec');
const SH = await import('../../src/server/sandbox/screenshots');
const P = await import('../../src/server/sandbox/publish');
const { FAKE_PNG } = await import('../../src/server/sandbox/fake-runner');
const { assertSafeSpec } = await import('../../src/server/sandbox/guards');
const { withActor } = await import('../../src/server/actor');
const route = await import('../../src/app/api/sandbox/tasks/[id]/screenshots/[file]/route');
const takeRoute = await import('../../src/app/api/sandbox/tasks/[id]/screenshots/route');
after(S.close);

const HEADER = 'src/Resources/views/storefront/layout/header/header.html.twig';
const shotSpecs = () => fake.calls.filter(c => c.op === 'create' && (c.detail as any).Image === SS.SCREENSHOT_IMAGE).map(c => c.detail as any);
const write = (id: string, text: string) => { const f = path.join(T.taskPaths(id).worktree, HEADER); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const take = (id: string) => takeRoute.POST(new Request(`http://127.0.0.1/api/sandbox/tasks/${id}/screenshots`, { method: 'POST' }), { params: Promise.resolve({ id }) });
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

test('environment: screenshots off by default; pages validated (default "/"), at most 5', () => {
  assert.equal(E.sandboxPublic().screenshots, false, 'off by default');
  assert.deepEqual(E.sandboxPublic().screenshotPaths, ['/']);
  assert.throws(() => E.saveSandbox({ screenshotPaths: ['http://evil/'] }), /Ungültiger Pfad/);
  assert.deepEqual(E.saveSandbox({ screenshotPaths: ['/', ' /checkout/cart ', '/'] }).changed, ['screenshotPaths']);
  assert.deepEqual(E.sandboxPublic().screenshotPaths, ['/', '/checkout/cart']);
  E.saveSandbox({ screenshotPaths: ['/'] });
});

let task: Awaited<ReturnType<typeof S.readyTask>>;
test('no screenshot step by default: the setup takes none, pulls no browser image, starts no screenshot container', async () => {
  task = await S.readyTask('Screenshots');
  const steps = task.steps.map(s => s.key as string);
  assert.ok(!steps.includes('screenshots'), steps.join(','));
  assert.deepEqual(steps.slice(steps.indexOf('theme-compile')), ['theme-compile', 'ready']);
  assert.deepEqual(SH.shotSets(task), []);
  assert.equal(shotSpecs().length, 0, 'no screenshot container');
  assert.ok(!fake.images.has(SS.SCREENSHOT_IMAGE), 'the browser image is not pulled');
  assert.deepEqual(T.publicTask(T.getTask(task.id)!).shots, []);
});

test('no screenshot step when publishing: steps Commit → Push → PR, the PR body says nothing about screenshots', async () => {
  const seen: string[] = [];
  const stop = setInterval(() => { const st = T.getTask(task.id)?.publish?.step; if (st && !seen.includes(st)) seen.push(st); }, 1);
  write(task.id, "{% sw_extends '@Storefront/storefront/layout/header/header.html.twig' %}\n{% block layout_header %}<div>Gratis Versand</div>{{ parent() }}{% endblock %}\n");
  try {
    const r = await withActor('alex', () => P.publishTask(task.id, { title: 'Header', body: 'Geprüft.' }));
    assert.equal(r.action, 'created');
  } finally { clearInterval(stop); }
  assert.ok(!seen.includes('screenshots'), seen.join(','));
  assert.equal(shotSpecs().length, 0, 'no screenshot container while publishing');
  assert.ok(!/Screenshot/.test(prBodies().at(-1)!), prBodies().at(-1) ?? '');
  assert.deepEqual(SH.shotSets(T.getTask(task.id)!), []);
});

test('manual screenshot: refused while switched off (400); the image route serves nothing', async () => {
  const r = await take(task.id);
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /ausgeschaltet/);
  assert.equal(shotSpecs().length, 0);
});

test('manual screenshot switched on: one set via putArchive/wait/getArchive, the container removed again; served by the image route', async () => {
  assert.deepEqual(E.saveSandbox({ screenshots: true }).changed, ['screenshots']);
  const r = await take(task.id);
  assert.equal(r.status, 200);
  const sets = SH.shotSets(T.getTask(task.id)!);
  assert.equal(sets.length, 1);
  const [set] = sets;
  assert.match(set.id, /^s[0-9a-z]{6,12}$/);
  assert.deepEqual(set.items, [{ path: '/', device: 'desktop', file: `${set.id}-1-desktop.png` }, { path: '/', device: 'mobile', file: `${set.id}-1-mobile.png` }]);
  assert.equal(set.error, undefined);
  assert.ok(fs.readFileSync(path.join(T.taskPaths(task.id).screenshots, `${set.id}-1-desktop.png`)).equals(FAKE_PNG));
  // the archive with script and job, owned by the non-root user; the container is gone afterwards
  const shotId = fake.calls.filter(c => c.op === 'putArchive' && c.detail === '/').at(-1)!.id!;
  const arch = fake.archives.find(a => a.id === shotId)!;
  assert.deepEqual(arch.entries.map(e => [e.path, e.uid]), [['lotse', 1001], ['lotse/out', 1001], ['lotse/shot.mjs', 1001], ['lotse/job.json', 1001]]);
  assert.equal(JSON.parse(arch.entries[3].data.toString()).proxy, `http://lotse-sbx-${task.id.replace(/_/g, '-')}:80`);
  assert.deepEqual(fake.calls.filter(c => c.id === shotId).map(c => c.op).filter(o => o !== 'inspect'), ['putArchive', 'start', 'wait', 'getArchive', 'remove']);
  assert.ok(!fake.containers.has(shotId), 'removed');
  assert.ok(shotSpecs().every(x => x.HostConfig.NetworkMode === 'lotse-sandbox'));
  assert.ok(fake.images.has(SS.SCREENSHOT_IMAGE), 'pulled on the first click');
  // public: urls of the image route only
  const pub = (await r.json()).task as ReturnType<typeof T.publicTask>;
  assert.equal(pub.shots.length, 1);
  assert.equal(pub.shots[0].shots[0].url, `/api/sandbox/tasks/${task.id}/screenshots/${set.id}-1-desktop.png`);
  const img = await get(task.id, `${set.id}-1-desktop.png`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(Buffer.from(await img.arrayBuffer()).equals(FAKE_PNG));
  fs.writeFileSync(path.join(T.taskPaths(task.id).screenshots, 'sabcdefgh-1-desktop.png'), FAKE_PNG);
  for (const f of ['sabcdefgh-1-desktop.png', '..%2F..%2Fsettings.json', '../x.png', `${set.id}-9-desktop.png`, `${set.id}-1-desktop.png.bak`, 'before-1-desktop.png']) assert.equal((await get(task.id, f)).status, 404, f);
  fs.rmSync(path.join(T.taskPaths(task.id).screenshots, 'sabcdefgh-1-desktop.png'));
});

test('the PR body mentions screenshots the user took – without a link, nothing uploaded', async () => {
  write(task.id, "{% sw_extends '@Storefront/storefront/layout/header/header.html.twig' %}\n{% block layout_header %}<div>Gratis Versand ab 50 €</div>{{ parent() }}{% endblock %}\n");
  const r = await withActor('alex', () => P.publishTask(task.id, { title: 'Header', body: 'Geprüft.' }));
  assert.equal(r.action, 'updated');
  const body = prBodies().at(-1)!;
  assert.match(body, /\*\*Screenshots:\*\* 2 Screenshots der Sandbox-Storefront \(`\/`\) liegen in Lotse/);
  assert.ok(!/https?:\/\/|\/api\/sandbox|!\[/.test(body.split('---')[0]), 'no link, no image');
  assert.ok(!gh.calls.some(c => /upload|contents|assets/.test(c.path)), 'nothing uploaded to GitHub');
  assert.equal(SH.shotSets(T.getTask(task.id)!).length, 1, 'publishing took none of its own');
});

test('a failing capture: partial set with reason; nothing at all = 502 and nothing stored; the container is always removed', async () => {
  fake.shooter = job => Object.fromEntries(job.shots.map(s => [s.file, s.file.includes('mobile') ? null : FAKE_PNG]));
  assert.equal((await take(task.id)).status, 200);
  const partial = SH.shotSets(T.getTask(task.id)!).at(-1)!;
  assert.deepEqual(partial.items.map(i => i.device), ['desktop']);
  assert.match(partial.error!, /1 von 2 Aufnahmen fehlen – \/ \(mobile\): Exit 1: net::ERR_CONNECTION_REFUSED/);
  fake.shooter = job => Object.fromEntries(job.shots.map(s => [s.file, Buffer.from('<html>not a png</html>')]));
  const r = await take(task.id);
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /Keine Screenshots entstanden: \/ \(desktop\): kein gültiges PNG/);
  assert.equal(SH.shotSets(T.getTask(task.id)!).length, 2, 'nothing stored for the failed capture');
  fake.failNext = { op: 'getArchive', message: 'Dateien abholen: Docker meldet HTTP 500' };
  fake.shooter = null;
  assert.equal((await take(task.id)).status, 502);
  assert.equal([...fake.containers.values()].filter(c => c.spec.Labels['lotse.role'] === 'screenshot').length, 0, 'every screenshot container removed');
});

test('at most MAX_SHOT_SETS sets: the oldest goes with its files', async () => {
  const first = SH.shotSets(T.getTask(task.id)!)[0];
  while (SH.shotSets(T.getTask(task.id)!).length < SH.MAX_SHOT_SETS) assert.equal((await take(task.id)).status, 200);
  assert.equal((await take(task.id)).status, 200);
  const sets = SH.shotSets(T.getTask(task.id)!);
  assert.equal(sets.length, SH.MAX_SHOT_SETS);
  assert.ok(!sets.some(x => x.id === first.id));
  assert.ok(!fs.readdirSync(T.taskPaths(task.id).screenshots).some(f => f.startsWith(`${first.id}-`)), 'its files are gone');
  assert.equal(new Set(sets.map(x => x.id)).size, sets.length, 'unique set ids');
});

test('paused sandbox: 409; a second click while one runs: 409; a running capture keeps the container from the idle sweeper', async () => {
  let release!: () => void;
  const pull = fake.ensureImage;
  fake.ensureImage = async () => { await new Promise<void>(r => (release = r)); return { pulled: false }; };
  const running = take(task.id);
  try {
    await S.until(() => SH.captureRunning(task.id));
    assert.equal((await take(task.id)).status, 409);
    assert.deepEqual(await J.pauseIdle(Date.now() + 365 * 24 * 3600_000), [], 'not paused under a capture');
    process.env.LOTSE_SANDBOX_MAX = '1';
    const other = T.createTask({ chatId: crypto.randomUUID(), title: 'Zweite', goal: '', repo: 'acme/shop-theme', baseBranch: 'main' });
    assert.throws(() => J.runSteps(other.id), (e: any) => e.status === 409);
    await J.deleteTask(other.id);
  } finally { delete process.env.LOTSE_SANDBOX_MAX; await S.until(() => !!release); release(); fake.ensureImage = pull; }
  assert.equal((await running).status, 200);
  await J.pauseTask(task.id);
  const r = await take(task.id);
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /läuft nicht/);
  await J.ensureAwake(task.id);
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

test('a new clone drops the screenshots; finish removes them with the task; the finished task lists none', async () => {
  assert.equal((await take(task.id)).status, 200);
  J.runSteps(task.id, 'clone');
  await S.until(() => !J.setupRunning(task.id));
  assert.deepEqual(SH.shotSets(T.getTask(task.id)!), []);
  assert.equal((await take(task.id)).status, 200);
  assert.ok(fs.readdirSync(T.taskPaths(task.id).screenshots).length > 0);
  await J.finishTask(task.id);
  assert.ok(!fs.existsSync(T.taskPaths(task.id).screenshots));
  assert.deepEqual(T.publicTask(T.getTask(task.id)!).shots, []);
  E.saveSandbox({ screenshots: false });
});

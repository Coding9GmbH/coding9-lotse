import crypto from 'node:crypto';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import '../isolate-data';
import { makePluginRepo } from '../support/plugin-repo';
import { startFakeGithub } from '../support/github-fake';
/* eslint-disable @typescript-eslint/no-explicit-any -- route contexts and JSON bodies are loose */

// Shop operators without developers (A15): "Neues Projekt" creates a private repository with the stored token (owner = user or one of
// its organisations, name validated, a clear refusal naming the permission) and the sandbox continues as a new plugin from it;
// "Plugin als ZIP herunterladen" builds a ZIP Shopware's "Erweiterung hochladen" accepts (top folder = technical name; .git,
// node_modules, tests, .env*, keys and secrets left out; vendor/ only when composer.json needs packages besides Shopware), checks
// composer.json first, refuses keys and tokens, is audited and only offered while the working copy exists.
for (const k of ['LOTSE_SANDBOX', 'LOTSE_PASSWORD', 'ALLOWED_HOSTS', 'HOSTNAME', 'HOST', 'AICB_DOCKER', 'LOTSE_BIND', 'LOTSE_SANDBOX_MAX', 'LOTSE_SANDBOX_IDLE_MINUTES', 'LOTSE_SANDBOX_NETWORK', 'LOTSE_SANDBOX_SUBNET', 'LOTSE_SANDBOX_RUNNER']) delete process.env[k];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-operators-'));
const seed = makePluginRepo(tmp, { repo: 'acme/shop-theme', name: 'AcmeShopTheme', theme: true });
process.env.LOTSE_GITHUB_CLONE_BASE = `file://${seed.remoteBase}`;
const TOKEN = `github_pat_${'Operat0r5x'.repeat(8)}_abc`;
// a repository created through the fake becomes a clone source, as GitHub's own README-only repository would be
const gh = await startFakeGithub({ token: TOKEN, login: 'mia-shop', orgs: ['acme'], repos: [{ fullName: 'acme/shop-theme' }],
  onCreateRepo: r => { makePluginRepo(tmp, { repo: r.fullName, empty: true }); } });
process.env.LOTSE_GITHUB_API_BASE = gh.base;

const { FakeRunner } = await import('../../src/server/sandbox/fake-runner');
const { setRunner } = await import('../../src/server/sandbox/runner');
const { allowFileRemotesForTests } = await import('../../src/server/git');
const { saveGithub, createRepo } = await import('../../src/server/github');
const { auditList } = await import('../../src/server/db');
const { zipEntries } = await import('../../src/server/zip-guard');
const { zipStream } = await import('../../src/server/zip-write');
const Z = await import('../../src/server/sandbox/plugin-zip');
const E = await import('../../src/server/sandbox/env');
const J = await import('../../src/server/sandbox/jobs');
const T = await import('../../src/server/sandbox/tasks');
const R = await import('../../src/server/sandbox/reconcile');
const L = await import('../../src/lib/sandbox-task');
const reposRoute = await import('../../src/app/api/sandbox/repos/route');
const tasksRoute = await import('../../src/app/api/sandbox/tasks/route');
const probeRoute = await import('../../src/app/api/sandbox/repo-probe/route');
const zipRoute = await import('../../src/app/api/sandbox/tasks/[id]/plugin-zip/route');

allowFileRemotesForTests(true);
saveGithub({ token: TOKEN });
const fake = new FakeRunner();
fake.images.add('dockware/shopware:6.7.15.1');
setRunner(fake);
E.saveSandbox({ enabled: true });
after(async () => { R.resetReconcile(); await fake.close(); await gh.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const until = async (fn: () => boolean, ms = 10_000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 10)); } };
const settled = (id: string) => until(() => !J.setupRunning(id) && T.getTask(id)!.status !== 'setting_up');
const createRepoReq = (body: unknown, lang = 'de') => reposRoute.POST(new Request('http://127.0.0.1/api/sandbox/repos', { method: 'POST', headers: { 'content-type': 'application/json', 'accept-language': lang }, body: JSON.stringify(body) }));
const zipReq = (id: string, check = false) => zipRoute.GET(new Request(`http://127.0.0.1/api/sandbox/tasks/${id}/plugin-zip${check ? '?check=1' : ''}`), { params: Promise.resolve({ id }) });
const leaks = (v: unknown) => JSON.stringify(v).includes(TOKEN);

/** All entries of a ZIP: name → contents (inflated), in archive order. */
function unzip(buf: Buffer): [string, Buffer][] {
  return zipEntries(buf).map(e => {
    const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28), data = buf.subarray(start, start + e.comp);
    const raw = e.method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
    assert.equal(raw.length, e.size, `size of ${e.name}`);
    return [e.name, raw];
  });
}
const readAll = async (s: ReadableStream<Uint8Array>) => Buffer.from(await new Response(s).arrayBuffer());

test('zip writer: directories and files round-trip (deflated or stored), UTF-8 names, CRC as zlib computes it', async () => {
  const text = Buffer.from('a'.repeat(5000)), tiny = Buffer.from('x'), umlaut = Buffer.from('Grüße\n');
  const buf = await readAll(zipStream([{ name: 'Top/' }, { name: 'Top/a.txt', data: () => text }, { name: 'Top/b.bin', data: () => tiny }, { name: 'Top/Größe.txt', data: () => umlaut }]));
  const out = unzip(buf);
  assert.deepEqual(out.map(([n]) => n), ['Top/', 'Top/a.txt', 'Top/b.bin', 'Top/Größe.txt']);
  assert.deepEqual(out[1][1], text); assert.deepEqual(out[2][1], tiny); assert.deepEqual(out[3][1], umlaut);
  const methods = zipEntries(buf).map(e => e.method);
  assert.deepEqual(methods, [0, 8, 0, 0], 'deflate only when it is smaller');
  // the central directory's CRC is the one zlib computes (unzip tools verify it)
  const cd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), 0);
  assert.equal(buf.readUInt32LE(buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), cd + 1) + 16), zlib.crc32(text) >>> 0);
  assert.throws(() => zipStream(Array.from({ length: 65_001 }, (_, i) => ({ name: `f${i}` }))), /Zu viele Einträge/);
  await assert.rejects(readAll(zipStream([{ name: '../evil', data: () => tiny }])), /Ungültiger Name/);
});

test('repository names: GitHub\'s rules, checked in the browser and on the server', () => {
  for (const ok of ['versandhinweis-plugin', 'Shop_Plugin.v2', 'a', 'x'.repeat(100)]) assert.ok(L.REPO_NAME.test(ok), ok);
  for (const bad of ['', '.', '..', 'a b', 'a/b', 'plugin.git', 'ä', 'x'.repeat(101), '-'.repeat(0)]) assert.ok(!L.REPO_NAME.test(bad), bad);
});

test('new project: owners are the user and its organisations; a private README-only repository is created and becomes a new plugin', async () => {
  const owners = await (await reposRoute.GET(new Request('http://127.0.0.1/api/sandbox/repos'))).json() as any;
  assert.deepEqual(owners.owners, [{ login: 'mia-shop', kind: 'user' }, { login: 'acme', kind: 'org' }]);
  const res = await createRepoReq({ owner: 'mia-shop', name: 'versandhinweis-plugin' });
  assert.equal(res.status, 201);
  const { repo } = await res.json() as any;
  assert.deepEqual({ fullName: repo.fullName, private: repo.private, push: repo.push, defaultBranch: repo.defaultBranch }, { fullName: 'mia-shop/versandhinweis-plugin', private: true, push: true, defaultBranch: 'main' });
  const call = gh.calls.find(c => c.method === 'POST' && c.path === '/user/repos')!;
  assert.deepEqual({ name: (call.body as any).name, private: (call.body as any).private, auto_init: (call.body as any).auto_init }, { name: 'versandhinweis-plugin', private: true, auto_init: true });
  const audit = auditList(5).find(a => a.kind === 'github-repo') as any;
  assert.equal(audit.repo, 'mia-shop/versandhinweis-plugin');
  assert.ok(!leaks(audit));
  // an organisation's repository goes to /orgs/<org>/repos
  assert.equal((await createRepoReq({ owner: 'acme', name: 'acme-banner' })).status, 201);
  assert.ok(gh.calls.some(c => c.method === 'POST' && c.path === '/orgs/acme/repos'));

  // the start dialog's probe sees an empty project and suggests the technical name; the sandbox builds a new plugin in it
  assert.deepEqual(await (await probeRoute.GET(new Request('http://127.0.0.1/api/sandbox/repo-probe?repo=mia-shop/versandhinweis-plugin&branch=main'))).json(), { empty: true, suggestedName: 'VersandhinweisPlugin' });
  const created = await tasksRoute.POST(new Request('http://127.0.0.1/api/sandbox/tasks', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId: crypto.randomUUID(), repo: 'mia-shop/versandhinweis-plugin', baseBranch: 'main', pluginName: 'MiaShippingNote' }) }));
  assert.equal(created.status, 201);
  const { task } = await created.json() as any;
  await settled(task.id);
  const t = T.getTask(task.id)!;
  assert.equal(t.status, 'ready', t.error ?? '');
  assert.deepEqual(t.layout, { kind: 'plugin', name: 'MiaShippingNote', pluginDir: 'custom/plugins/MiaShippingNote', isNew: true });
  await J.deleteTask(t.id);
});

test('new project refused: invalid name, unknown owner, name taken, token without the permission (named, German and English)', async () => {
  const bad = await createRepoReq({ owner: 'mia-shop', name: 'mein plugin' });
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as any).error, /Ungültiger Projektname/);
  const owner = await createRepoReq({ owner: 'someone-else', name: 'x' });
  assert.equal(owner.status, 400);
  assert.match(((await owner.json()) as any).error, /gehört nicht zum gespeicherten GitHub-Token/);
  const taken = await createRepoReq({ owner: 'mia-shop', name: 'versandhinweis-plugin' });
  assert.equal(taken.status, 409);
  assert.match(((await taken.json()) as any).error, /Projekt mia-shop\/versandhinweis-plugin gibt es auf GitHub schon/);
  gh.createDenied = true;
  try {
    const denied = await createRepoReq({ owner: 'acme', name: 'neues-plugin' });
    assert.equal(denied.status, 403);
    const msg = ((await denied.json()) as any).error as string;
    assert.match(msg, /darf unter acme keine Repositorys anlegen/);
    assert.match(msg, /„Administration: Lesen & Schreiben“/);
    assert.match(msg, /Scope „repo“/);
    assert.ok(!leaks(msg));
    assert.match(((await (await createRepoReq({ owner: 'acme', name: 'neues-plugin' }, 'en')).json()) as any).error, /needs the permission “Administration: Read and write”[\s\S]*scope “repo”/);
    await assert.rejects(createRepo({ owner: 'acme', name: 'neues-plugin' }), (e: any) => e.code === 'permission');
  } finally { gh.createDenied = false; }
  // switched off: the sandbox routes refuse before anything reaches GitHub
  E.saveSandbox({ enabled: false });
  try { assert.equal((await createRepoReq({ owner: 'mia-shop', name: 'later' })).status, 403); } finally { E.saveSandbox({ enabled: true }); }
});

// ---- Plugin ZIP ----
const NAME = 'AcmeShopTheme';
/** A ready task on acme/shop-theme (theme plugin with .env, a key and symlinks in the repository). */
async function readyTask() {
  const t = T.createTask({ chatId: crypto.randomUUID(), title: 'ZIP', repo: 'acme/shop-theme', baseBranch: 'main' });
  J.runSteps(t.id); await settled(t.id);
  const done = T.getTask(t.id)!;
  assert.equal(done.status, 'ready', done.error ?? '');
  return done;
}
const put = (t: { id: string }, files: Record<string, string>) => {
  const wt = T.taskPaths(t.id).worktree;
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(wt, f)), { recursive: true }); fs.writeFileSync(path.join(wt, f), c); }
};
const composer = (over: Record<string, unknown> = {}) => JSON.stringify({ name: 'acme/acmeshoptheme', type: 'shopware-platform-plugin', description: 'Theme', version: '1.2.0', license: 'MIT',
  autoload: { 'psr-4': { 'Acme\\AcmeShopTheme\\': 'src/' } }, extra: { 'shopware-plugin-class': 'Acme\\AcmeShopTheme\\AcmeShopTheme', label: { 'de-DE': 'Theme', 'en-GB': 'Theme' } }, require: { 'shopware/core': '~6.7.0' }, ...over }, null, 2);

test('plugin ZIP: top folder = technical name, development files and secrets left out, content as on disk (uncommitted too), audited', async () => {
  const t = await readyTask();
  put(t, {
    'src/Resources/views/storefront/base.html.twig': '{# not committed yet #}\n',
    'tests/PluginTest.php': '<?php // test\n', 'src/Resources/app/administration/Tests/a.spec.js': 'x', 'node_modules/x/index.js': 'x', '.github/workflows/ci.yml': 'on: push\n',
    '.env.local': 'A=1\n', '.env.dist': 'A=\n', 'config/jwt/private.pem': 'k', 'auth.json': '{}', 'phpunit.xml.dist': '<phpunit/>', '.gitignore': 'vendor/\n', 'vendor/autoload.php': '<?php\n',
  });
  const check = await (await zipReq(t.id, true)).json() as any;
  assert.deepEqual({ ok: check.ok, name: check.name, version: check.version, problems: check.problems, vendor: check.vendor }, { ok: true, name: NAME, version: '1.0.0', problems: [], vendor: false });
  const res = await zipReq(t.id);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="AcmeShopTheme-1\.0\.0\.zip"/);
  const entries = unzip(Buffer.from(await res.arrayBuffer()));
  const names = entries.map(([n]) => n);
  assert.equal(names[0], `${NAME}/`, 'Shopware reads the plugin folder from the first entry');
  assert.ok(names.every(n => n.startsWith(`${NAME}/`)));
  for (const f of ['composer.json', `src/${NAME}.php`, 'src/Resources/theme.json', 'src/Resources/views/storefront/base.html.twig', 'README.md', 'src/Resources/app/storefront/src/assets/.gitkeep']) assert.ok(names.includes(`${NAME}/${f}`), f);
  const segs = names.map(n => n.slice(NAME.length + 1).replace(/\/$/, '').split('/'));
  for (const bad of ['.git', 'tests', 'Tests', 'node_modules', '.github', '.env', '.env.local', '.env.dist', 'keys', 'deploy.pem', 'config', 'auth.json', 'phpunit.xml.dist', '.gitignore', 'vendor', 'outside-link', 'inside-link']) {
    assert.ok(!segs.some(s => s.includes(bad)), bad);
  }
  assert.equal(String(entries.find(([n]) => n === `${NAME}/src/Resources/views/storefront/base.html.twig`)![1]), '{# not committed yet #}\n');
  assert.ok(!entries.some(([, c]) => c.toString().includes('never-in-the-container') || c.toString().includes('PRIVATE KEY')), 'no secret content');
  const audit = auditList(5).find(a => a.kind === 'sandbox-task' && a.action === 'zip') as any;
  assert.deepEqual({ plugin: audit.plugin, files: audit.files, vendor: audit.vendor, taskId: audit.taskId }, { plugin: NAME, files: check.files, vendor: false, taskId: t.id });
  assert.equal(check.files, names.filter(n => !n.endsWith('/')).length);
  await J.deleteTask(t.id);
});

test('plugin ZIP: vendor/ only when composer.json needs packages besides Shopware and the working copy has it', async () => {
  const t = await readyTask();
  put(t, { 'composer.json': composer({ require: { 'shopware/core': '~6.7.0', php: '>=8.2', 'ext-json': '*', 'acme/pdf-lib': '^2.0' } }) });
  let c = Z.checkPluginZip(T.getTask(t.id)!);
  assert.equal(c.ok, true);
  assert.equal(c.vendor, false);
  assert.ok(c.warnings.includes('vendorMissing'), 'needs packages, but there is no vendor/');
  put(t, { 'vendor/autoload.php': '<?php\n', 'vendor/acme/pdf-lib/src/Pdf.php': '<?php\n', 'vendor/acme/pdf-lib/tests/PdfTest.php': '<?php\n' });
  c = Z.checkPluginZip(T.getTask(t.id)!);
  assert.equal(c.vendor, true);
  assert.ok(!c.warnings.includes('vendorMissing'));
  const names = unzip(await readAll(Z.pluginZip(T.getTask(t.id)!).stream!)).map(([n]) => n);
  assert.ok(names.includes(`${NAME}/vendor/autoload.php`) && names.includes(`${NAME}/vendor/acme/pdf-lib/src/Pdf.php`));
  assert.ok(!names.includes(`${NAME}/vendor/acme/pdf-lib/tests/PdfTest.php`), 'tests inside vendor are left out too');
  await J.deleteTask(t.id);
});

test('plugin ZIP: composer.json is checked first (what is missing), keys refuse the ZIP, a finished sandbox has none', async () => {
  const t = await readyTask();
  put(t, { 'composer.json': composer({ version: undefined, type: 'library', extra: { 'shopware-plugin-class': 'Acme\\AcmeShopTheme\\AcmeShopTheme' }, description: '' }) });
  let c = await (await zipReq(t.id, true)).json() as any;
  assert.equal(c.ok, false);
  assert.deepEqual(c.problems, ['type', 'description', 'version', 'label'], 'what Shopware needs to list the plugin at all');
  assert.deepEqual(c.warnings, []);
  const refused = await zipReq(t.id);
  assert.equal(refused.status, 422);
  assert.match(((await refused.json()) as any).error, /Kein ZIP möglich: type, description, version, label/);
  // composer's own patterns (Shopware skips a plugin composer rejects); a string label would even break Shopware's plugin list
  const probs = (over: Record<string, unknown>) => { put(t, { 'composer.json': composer(over) }); return Z.checkPluginZip(T.getTask(t.id)!).problems; };
  assert.deepEqual(probs({ name: 'Acme/Shop-Theme' }), ['name']);
  assert.deepEqual(probs({ version: 'eins' }), ['version']);
  assert.deepEqual(probs({ version: 'v2.1.0-beta1' }), []);
  assert.deepEqual(probs({ autoload: { classmap: ['src/'] } }), ['autoload']);
  assert.deepEqual(probs({ extra: { 'shopware-plugin-class': 'Acme\\AcmeShopTheme\\AcmeShopTheme', label: 'Theme' } }), ['label']);
  assert.deepEqual(probs({ extra: { 'shopware-plugin-class': 'Acme\\AcmeShopTheme\\AcmeShopTheme', label: { 'de-DE': 'Nur Deutsch' } } }), []);
  assert.deepEqual(probs({ extra: { 'shopware-plugin-class': 'Acme\\AcmeShopTheme\\Acme-Theme', label: { 'de-DE': 'x' } } }), ['pluginName']);
  put(t, { 'composer.json': composer({ require: { php: '>=8.2' } }) });
  assert.deepEqual(Z.checkPluginZip(T.getTask(t.id)!).warnings, ['requireCore']);
  // the class file is looked up where psr-4 points
  put(t, { 'composer.json': composer({ autoload: { 'psr-4': { 'Acme\\AcmeShopTheme\\': 'lib/' } } }) });
  c = Z.checkPluginZip(T.getTask(t.id)!);
  assert.equal(c.ok, true);
  assert.deepEqual(c.warnings, ['classFile']);
  put(t, { 'composer.json': '{ nope' });
  assert.deepEqual(Z.checkPluginZip(T.getTask(t.id)!).problems, ['badJson']);
  put(t, { 'composer.json': composer(), 'src/Service/Client.php': `<?php\n$token = 'ghp_${'a'.repeat(36)}';\n` });
  c = Z.checkPluginZip(T.getTask(t.id)!);
  assert.deepEqual(c.problems, ['secret']);
  assert.equal(c.secretFile, 'src/Service/Client.php');
  const secret = await zipReq(t.id);
  assert.equal(secret.status, 422);
  assert.match(((await secret.json()) as any).error, /src\/Service\/Client\.php enthält einen Schlüssel oder Token/);
  fs.rmSync(path.join(T.taskPaths(t.id).worktree, 'src/Service/Client.php'));
  assert.equal(Z.checkPluginZip(T.getTask(t.id)!).ok, true);
  await J.finishTask(t.id);
  const gone = await zipReq(t.id, true);
  assert.equal(gone.status, 409);
  assert.match(((await gone.json()) as any).error, /keine Arbeitskopie/);
  await J.deleteTask(t.id);
});

test('plugin ZIP of a new plugin before its skeleton: composer.json missing', async () => {
  const res = await createRepoReq({ owner: 'mia-shop', name: 'leer' });
  assert.equal(res.status, 201);
  const t = T.createTask({ chatId: crypto.randomUUID(), title: 'Leer', repo: 'mia-shop/leer', baseBranch: 'main', pluginName: 'MiaLeer' });
  J.runSteps(t.id); await settled(t.id);
  const c = Z.checkPluginZip(T.getTask(t.id)!);
  assert.deepEqual({ ok: c.ok, problems: c.problems, name: c.name }, { ok: false, problems: ['noComposer'], name: null });
  assert.equal(Z.zipExcluded('README.md', false), false);
  await J.deleteTask(t.id);
});

import crypto from 'node:crypto';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../isolate-data';
import { makePluginRepo, makeProjectRepo } from '../support/plugin-repo';
import { startFakeGithub } from '../support/github-fake';
/* eslint-disable @typescript-eslint/no-explicit-any -- tool handlers and route contexts take loose input */

// A Shopware project in a subfolder of the repository (shop/), with other things in the root (a frontend, infrastructure, a README):
// detection (also with other composer.json files around, several candidates, projectDir in .lotse/sandbox.json), what is synced
// (only the subfolder, paths inside it), edits and files taken over from the container (repository paths with the subfolder in front),
// the ZIP of one plugin, publishing rules and the agent's prompt.
for (const k of ['LOTSE_SANDBOX', 'LOTSE_PASSWORD', 'ALLOWED_HOSTS', 'HOSTNAME', 'HOST', 'AICB_DOCKER', 'LOTSE_BIND', 'LOTSE_SANDBOX_MAX', 'LOTSE_SANDBOX_IDLE_MINUTES', 'LOTSE_SANDBOX_NETWORK', 'LOTSE_SANDBOX_SUBNET', 'LOTSE_SANDBOX_RUNNER']) delete process.env[k];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-subdir-'));
const ROOT_FILES = { 'README.md': '# Monorepo\n', 'frontend/package.json': '{"name":"frontend"}\n', 'infra/deploy.sh': '#!/bin/sh\necho deploy\n', '.env': 'ROOT_SECRET=never-in-the-container\n' };
const shop = makeProjectRepo(tmp, { repo: 'acme/mono', subdir: 'shop', rootFiles: ROOT_FILES });
makeProjectRepo(tmp, { repo: 'acme/mono-tooling', subdir: 'shop', rootFiles: { ...ROOT_FILES, 'composer.json': JSON.stringify({ name: 'acme/tooling', type: 'library', require: { 'symfony/console': '^7' } }) } });
makePluginRepo(tmp, { repo: 'acme/shop-theme', theme: true });
process.env.LOTSE_GITHUB_CLONE_BASE = `file://${shop.remoteBase}`;
const TOKEN = `github_pat_${'Subd1rRepo'.repeat(8)}_abc`;
const gh = await startFakeGithub({ token: TOKEN, repos: ['acme/mono', 'acme/mono-tooling', 'acme/shop-theme'].map(fullName => ({ fullName })) });
process.env.LOTSE_GITHUB_API_BASE = gh.base;

const { FakeRunner } = await import('../../src/server/sandbox/fake-runner');
const { setRunner } = await import('../../src/server/sandbox/runner');
const { allowFileRemotesForTests } = await import('../../src/server/git');
const { saveGithub } = await import('../../src/server/github');
const { getSession } = await import('../../src/server/sessions');
const { zipEntries } = await import('../../src/server/zip-guard');
const P = await import('../../src/server/sandbox/project');
const E = await import('../../src/server/sandbox/env');
const J = await import('../../src/server/sandbox/jobs');
const T = await import('../../src/server/sandbox/tasks');
const W = await import('../../src/server/sandbox/workspace-tools');
const Z = await import('../../src/server/sandbox/plugin-zip');
const PULL = await import('../../src/server/sandbox/container-pull');
const { blockReason } = await import('../../src/server/sandbox/publish');
const { parseRepoFile } = await import('../../src/server/sandbox/repo-config');
const { detectLayout } = await import('../../src/server/sandbox/templates/dockware');
const { codeSystemFor } = await import('../../src/server/prompt');
const zipRoute = await import('../../src/app/api/sandbox/tasks/[id]/plugin-zip/route');

allowFileRemotesForTests(true);
saveGithub({ token: TOKEN });
const fake = new FakeRunner();
fake.images.add('dockware/shopware:6.7.15.1');
setRunner(fake);
E.saveSandbox({ enabled: true });
after(async () => { await fake.close(); await gh.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const until = async (fn: () => boolean, ms = 10_000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 10)); } };
const settled = (id: string) => until(() => !J.setupRunning(id) && T.getTask(id)!.status !== 'setting_up');
const files = (cid: string) => fake.containers.get(cid)!.files;
const ROOT = '/var/www/html';
const dir = (fx: Record<string, string>) => {
  const d = fs.mkdtempSync(path.join(tmp, 'wt-'));
  for (const [f, c] of Object.entries(fx)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); }
  return d;
};
const seed = path.join(tmp, 'seed-acme-mono');
const projectComposer = (name: string) => JSON.stringify({ name, type: 'project', require: { 'shopware/core': 'v6.7.15.1' } });

test('detectLayout: the shop in a subfolder is a project with root "shop"; the root\'s other things do not matter', () => {
  const l = detectLayout(seed, { repo: 'acme/mono' });
  assert.equal(l.kind, 'project');
  assert.equal(l.root, 'shop');
  assert.equal(l.pluginDir, '');
  assert.deepEqual(l.project!.plugins.map(x => x.dir), ['custom/plugins/AcmeStorefrontTweaks', 'custom/plugins/AcmeTheme', 'custom/static-plugins/AcmeErpConnector']);
  assert.equal(l.project!.shopwareVersion, '6.7.15.1');
  assert.equal(l.project!.src, true);
  // another composer.json in the root (tooling) does not hide it
  const tooling = detectLayout(path.join(tmp, 'seed-acme-mono-tooling'), { repo: 'acme/mono-tooling' });
  assert.deepEqual([tooling.kind, tooling.root], ['project', 'shop']);
  // a project in the root has no root (as before); a plugin repository is unchanged
  assert.equal(detectLayout(dir({ 'composer.json': projectComposer('acme/x'), 'config/packages/a.yaml': 'framework: {}\n' }), { repo: 'acme/x' }).root, undefined);
  assert.equal(detectLayout(path.join(tmp, 'seed-acme-shop-theme')).kind, 'theme');
});

test('detectLayout: two projects need projectDir, projectDir picks one, a wrong one says so, links are never searched', () => {
  const two = dir({ 'a/composer.json': projectComposer('acme/a'), 'a/config/packages/x.yaml': 'a: 1\n', 'apps/b/composer.json': projectComposer('acme/b'), 'apps/b/bin/console': '' });
  assert.throws(() => detectLayout(two), /mehrere Shopware-Projekte \(a, apps\/b\)[\s\S]*"projectDir"/);
  assert.equal(detectLayout(two, { projectDir: 'apps/b' }).root, 'apps/b');
  assert.equal(detectLayout(two, { projectDir: 'a' }).name, 'acme/a');
  assert.throws(() => detectLayout(two, { projectDir: 'nope' }), /kein normaler Ordner/);
  assert.throws(() => detectLayout(two, { projectDir: '../x' }), /kein gültiger Ordnername/);
  assert.throws(() => detectLayout(dir({ 'a/README.md': 'x\n' }), { projectDir: 'a' }), /liegt kein Shopware-Projekt/);
  // a symlinked folder is not searched and not accepted as projectDir
  const linked = dir({ 'README.md': 'x\n', 'real/composer.json': projectComposer('acme/r'), 'real/bin/console': '' });
  fs.symlinkSync(path.join(linked, 'real'), path.join(linked, 'shop'));
  assert.deepEqual(P.findProjectDirs(linked), ['real']);
  assert.throws(() => detectLayout(linked, { projectDir: 'shop' }), /kein normaler Ordner/);
  // nothing found: the old messages
  assert.throws(() => detectLayout(dir({ 'README.md': 'x\n', 'frontend/package.json': '{}' })), /Kein Shopware-Plugin erkannt/);
  assert.throws(() => detectLayout(dir({ 'composer.json': JSON.stringify({ type: 'project', require: { 'symfony/framework-bundle': '^7' } }), 'bin/console': '' })), /Kein Shopware-Projekt erkannt/);
});

test('path helpers: repository path ↔ path inside the project folder', () => {
  assert.equal(P.underRoot('shop', 'shop/custom/plugins/A/x.php'), 'custom/plugins/A/x.php');
  assert.equal(P.underRoot('shop', 'frontend/a.js'), null);
  assert.equal(P.underRoot('shop', 'shop'), null);
  assert.equal(P.underRoot('shop', 'shopware/a'), null);
  assert.equal(P.underRoot('', 'a/b'), 'a/b');
  assert.equal(P.withRoot('apps/shop', 'src/A.php'), 'apps/shop/src/A.php');
  assert.equal(P.withRoot('', 'src/A.php'), 'src/A.php');
  assert.ok(P.PROJECT_DIR.test('shop') && P.PROJECT_DIR.test('apps/shop') && !P.PROJECT_DIR.test('.git') && !P.PROJECT_DIR.test('../x') && !P.PROJECT_DIR.test('a/b/c/d') && !P.PROJECT_DIR.test('/abs'));
});

test('.lotse/sandbox.json: projectDir is read, only for a project', () => {
  assert.equal(parseRepoFile(Buffer.from('{"projectDir":"shop"}')).projectDir, 'shop');
  assert.equal(parseRepoFile(Buffer.from('{"mode":"project","projectDir":"apps/shop"}')).projectDir, 'apps/shop');
  assert.throws(() => parseRepoFile(Buffer.from('{"projectDir":"../x"}')), /projectDir/);
  assert.throws(() => parseRepoFile(Buffer.from('{"projectDir":".git"}')), /projectDir/);
  assert.throws(() => parseRepoFile(Buffer.from('{"mode":"plugin","projectDir":"shop"}')), /„projectDir“ gilt nur mit "mode": "project"/);
});

test('publishing: inside shop/ the project\'s rules, next to it the rest of the repository (never dependencies, workflows, secrets)', () => {
  const ok = (p: string) => blockReason([{ path: p, status: 'M' }], 'project', 'de', 'shop');
  for (const p of ['shop/custom/plugins/AcmeTheme/src/Resources/theme.json', 'shop/config/packages/shopware.yaml', 'shop/src/A.php', 'shop/composer.json', 'frontend/src/app.js', 'infra/deploy.sh', 'README.md', 'docs/x.md'])
    assert.equal(ok(p), null, p);
  assert.match(ok('shop/vendor/autoload.php')!, /Abhängigkeit oder Build-Ausgabe/);
  assert.match(ok('shop/public/theme/x.css')!, /Abhängigkeit oder Build-Ausgabe/);
  assert.match(ok('frontend/node_modules/a/index.js')!, /Abhängigkeit oder Build-Ausgabe/);
  assert.match(ok('shop/bin/console')!, /außerhalb der Bereiche/);
  assert.match(ok('shop/bin/console')!, /shop\/bin\/console/, 'the message names the repository path');
  assert.match(ok('shop/.env')!, /geschützte Datei/);
  assert.match(ok('shop/config/jwt/private.pem')!, /geschützte Datei/);
  assert.match(ok('.env')!, /geschützte Datei/);
  assert.match(ok('.github/workflows/ci.yml')!, /GitHub-Workflows/);
  // without a subfolder nothing changed
  assert.match(blockReason([{ path: 'frontend/a.js', status: 'M' }], 'project')!, /außerhalb der Bereiche/);
});

let task = '';
test('setup: only the subfolder reaches the container, with paths inside it; the root\'s files and .env stay on the host', async () => {
  const t = T.createTask({ chatId: crypto.randomUUID(), title: 'Footer im Monorepo', goal: 'Footer-Text ändern.', repo: 'acme/mono', baseBranch: 'main' });
  getSession(t.chatId!);
  J.runSteps(t.id);
  await settled(t.id);
  const done = T.getTask(t.id)!;
  assert.equal(done.status, 'ready', done.error ?? '');
  task = t.id;
  assert.equal(done.layout!.kind, 'project');
  assert.equal(done.layout!.root, 'shop');
  assert.match(done.steps.find(s => s.key === 'detect-layout')!.log.join('\n'), /Shopware-Projekt acme\/shop \(Ordner shop\/ im Repository\) → \/var\/www\/html/);
  const fsys = files(done.containerId!);
  for (const f of ['custom/plugins/AcmeTheme/src/Resources/theme.json', 'custom/static-plugins/AcmeErpConnector/composer.json', 'custom/apps/AcmeHelloApp/manifest.xml', 'config/packages/shopware.yaml', 'src/Subscriber/ProjectHeaderSubscriber.php'])
    assert.ok(fsys.has(`${ROOT}/${f}`), f);
  for (const f of ['README.md', 'frontend/package.json', 'infra/deploy.sh', '.env', 'shop/custom/plugins/AcmeTheme/composer.json', 'composer.json', 'public/index.php'])
    assert.ok(!fsys.has(`${ROOT}/${f}`), `${f} must not be synced`);
  assert.ok(![...fsys.values()].some(b => b.toString('utf8').includes('never-in-the-container')), 'no .env content anywhere');
  // the plugins were installed from the project's folder
  assert.ok(fake.calls.some(c => c.op === 'exec' && c.id === done.containerId && c.argv!.join(' ').startsWith('bin/console plugin:install --activate -n -- ')));
});

test('edits: repository paths below shop/ are synced to the project path, files next to it stay on the host', async () => {
  const t = T.getTask(task)!, cid = t.containerId!, wt = T.taskPaths(t.id).worktree;
  const put = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true }); fs.writeFileSync(path.join(wt, rel), text); };
  const twig = 'custom/plugins/AcmeTheme/src/Resources/views/storefront/layout/footer/footer.html.twig';
  put(`shop/${twig}`, '{% block layout_footer_copyright %}Monorepo{% endblock %}\n');
  assert.equal(await W.syncChanged(t.id, [`shop/${twig}`]), ' und in den Container übertragen');
  assert.equal(files(cid).get(`${ROOT}/${twig}`)!.toString(), '{% block layout_footer_copyright %}Monorepo{% endblock %}\n');
  assert.ok(!files(cid).has(`${ROOT}/shop/${twig}`), 'never below a shop/ folder in the container');
  // a file of the root: nothing uploaded, nothing deleted
  put('frontend/src/app.js', 'console.log(1)\n');
  const n = fake.archives.length;
  assert.equal(await W.syncChanged(t.id, ['frontend/src/app.js', 'README.md']), ' und in den Container übertragen');
  assert.equal(fake.archives.length, n, 'nothing uploaded for files outside shop/');
  // a deleted file below shop/ disappears in the container
  const snippet = 'custom/plugins/AcmeStorefrontTweaks/src/Resources/snippet/storefront.de-DE.json';
  assert.ok(files(cid).has(`${ROOT}/${snippet}`));
  fs.rmSync(path.join(wt, 'shop', snippet));
  await W.syncChanged(t.id, [`shop/${snippet}`]);
  assert.ok(!files(cid).has(`${ROOT}/${snippet}`));
  // a command first mirrors changes it did not see (the manifest is read inside the project folder)
  put(`shop/${twig}`, '{% block layout_footer_copyright %}Zweiter Stand{% endblock %}\n');
  const tools = W.sandboxTools({ id: 'chat-subdir', taskId: t.id, emit: () => {}, askUser: async () => '', approvals: new Map(), abort: null });
  assert.ok(!(await tools.find(x => x.name === 'sandbox_bash')!.handler({ command: 'bin/console cache:clear' } as any, {})).isError);
  assert.equal(files(cid).get(`${ROOT}/${twig}`)!.toString(), '{% block layout_footer_copyright %}Zweiter Stand{% endblock %}\n');
});

test('taking files over from the container: compared inside the project folder, shown and written as repository paths', async () => {
  const t = T.getTask(task)!, cid = t.containerId!, wt = T.taskPaths(t.id).worktree;
  // what bin/console plugin:create or the AI's sandbox_bash makes in the container
  files(cid).set(`${ROOT}/custom/plugins/AcmeNew/composer.json`, Buffer.from('{"name":"acme/new","type":"shopware-platform-plugin"}\n'));
  files(cid).set(`${ROOT}/custom/plugins/AcmeNew/src/AcmeNew.php`, Buffer.from('<?php\n'));
  const c = await PULL.containerChanges(T.getTask(task)!);
  const paths = c.changes.map(x => x.path);
  assert.ok(paths.includes('shop/custom/plugins/AcmeNew/composer.json') && paths.includes('shop/custom/plugins/AcmeNew/src/AcmeNew.php'), paths.join(', '));
  assert.ok(c.changes.every(x => x.path.startsWith('shop/')), 'every path names the subfolder');
  assert.match(c.diff, /\+\+\+ b\/shop\/custom\/plugins\/AcmeNew\/composer\.json/);
  // the AI names repository paths; one outside the project folder matches nothing
  const none = await PULL.takeOver(T.getTask(task)!, { all: true, under: ['frontend'] }, { via: 'ai' });
  assert.deepEqual(none.taken, []);
  const r = await PULL.takeOver(T.getTask(task)!, { all: true, under: ['shop/custom/plugins/AcmeNew'] }, { via: 'ai' });
  assert.deepEqual(r.taken.map(x => x.path).sort(), ['shop/custom/plugins/AcmeNew/composer.json', 'shop/custom/plugins/AcmeNew/src/AcmeNew.php']);
  assert.equal(fs.readFileSync(path.join(wt, 'shop/custom/plugins/AcmeNew/src/AcmeNew.php'), 'utf8'), '<?php\n');
  assert.ok(!fs.existsSync(path.join(wt, 'custom')), 'never next to shop/');
  // taken over: the container has them, so they are no difference any more and need no second transfer
  assert.deepEqual((await PULL.containerChanges(T.getTask(task)!)).changes, []);
  // the panel names them by repository path too
  files(cid).set(`${ROOT}/src/Added.php`, Buffer.from('<?php // added\n'));
  const next = await PULL.containerChanges(T.getTask(task)!);
  const added = next.changes.find(x => x.path === 'shop/src/Added.php')!;
  assert.ok(added);
  const viaItems = await PULL.takeOver(T.getTask(task)!, { items: [{ path: added.path, sha: added.sha }, { path: 'frontend/x.js', sha: null }] }, { via: 'panel' });
  assert.deepEqual(viaItems.taken.map(x => x.path), ['shop/src/Added.php']);
  assert.equal(viaItems.refused.length, 1);
  assert.ok(fs.existsSync(path.join(wt, 'shop/src/Added.php')));
});

test('ZIP of one plugin: the plugin folders are relative to shop/', async () => {
  const t = T.getTask(task)!;
  const c = Z.checkPluginZip(t, 'custom/plugins/AcmeTheme');
  assert.equal(c.ok, true, JSON.stringify(c.problems));
  assert.equal(c.name, 'AcmeTheme');
  assert.ok(c.plugins!.some(x => x.dir === 'custom/plugins/AcmeTheme'));
  const res = await zipRoute.GET(new Request(`http://127.0.0.1/api/sandbox/tasks/${t.id}/plugin-zip?plugin=${encodeURIComponent('custom/plugins/AcmeTheme')}`), { params: Promise.resolve({ id: t.id }) });
  assert.equal(res.status, 200);
  const names = zipEntries(Buffer.from(await res.arrayBuffer())).map(e => e.name);
  assert.ok(names.includes('AcmeTheme/composer.json') && names.every(n => n.startsWith('AcmeTheme/')));
});

test('the agent\'s prompt says where the project is and which paths are which', () => {
  const sys = codeSystemFor(task, 'de', false);
  assert.match(sys, /WICHTIG – Unterordner: Das Shopware-Projekt liegt im Repository im Ordner shop\//);
  assert.match(sys, /im Repository shop\/custom\/plugins\/<Name> und im Container \/var\/www\/html\/custom\/plugins\/<Name>/);
  assert.match(sys, /MIT shop\/[\s\S]*OHNE shop\//);
  // a project in the root has no such note
  const plain = codeSystemFor(T.createTask({ chatId: crypto.randomUUID(), title: 'x', repo: 'acme/mono', baseBranch: 'main' }).id, 'de', false);
  assert.ok(!/WICHTIG – Unterordner/.test(plain));
});

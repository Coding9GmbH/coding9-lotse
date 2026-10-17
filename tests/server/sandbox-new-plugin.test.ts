import crypto from 'node:crypto';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../isolate-data';
import type { ChatEvent } from '@/lib/protocol';
import { makePluginRepo } from '../support/plugin-repo';
import { startFakeGithub } from '../support/github-fake';
/* eslint-disable @typescript-eslint/no-explicit-any -- tool handlers and route contexts take loose input */

// A new plugin from an (almost) empty repository, with the FakeRunner and a bare file:// remote: detect-layout marks the task as a new
// plugin (name chosen by the user, else derived from the repository), install and theme compile are skipped, the task is ready with a
// container; the agent's files are synced to custom/plugins/<Name>, plugin:install runs via sandbox_bash, the layout settles into an
// ordinary plugin and a later setup detects it normally. Plus the start dialog's probe and the name validation.
for (const k of ['LOTSE_SANDBOX', 'LOTSE_PASSWORD', 'ALLOWED_HOSTS', 'HOSTNAME', 'HOST', 'AICB_DOCKER', 'LOTSE_BIND', 'LOTSE_SANDBOX_MAX', 'LOTSE_SANDBOX_IDLE_MINUTES', 'LOTSE_SANDBOX_NETWORK', 'LOTSE_SANDBOX_SUBNET', 'LOTSE_SANDBOX_RUNNER']) delete process.env[k];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-newplugin-'));
const empty = makePluginRepo(tmp, { repo: 'conine/header-banner', empty: true });
process.env.LOTSE_GITHUB_CLONE_BASE = `file://${empty.remoteBase}`;
const TOKEN = `github_pat_${'NewPlug1n4'.repeat(8)}_abc`;
const gh = await startFakeGithub({ token: TOKEN, repos: [
  { fullName: 'conine/header-banner', files: ['README.md', 'LICENSE', '.gitignore'] },
  { fullName: 'acme/shop-theme' },
] });
process.env.LOTSE_GITHUB_API_BASE = gh.base;

const { FakeRunner } = await import('../../src/server/sandbox/fake-runner');
const { setRunner } = await import('../../src/server/sandbox/runner');
const { allowFileRemotesForTests } = await import('../../src/server/git');
const { saveGithub } = await import('../../src/server/github');
const E = await import('../../src/server/sandbox/env');
const J = await import('../../src/server/sandbox/jobs');
const T = await import('../../src/server/sandbox/tasks');
const R = await import('../../src/server/sandbox/reconcile');
const W = await import('../../src/server/sandbox/workspace-tools');
const { detectLayout } = await import('../../src/server/sandbox/templates/dockware');
const { codeSystemFor } = await import('../../src/server/prompt');
const { startSandboxTool } = await import('../../src/server/sandbox/offer-tool');
const L = await import('../../src/lib/sandbox-task');
const tasksRoute = await import('../../src/app/api/sandbox/tasks/route');
const probeRoute = await import('../../src/app/api/sandbox/repo-probe/route');

allowFileRemotesForTests(true);
saveGithub({ token: TOKEN });
const fake = new FakeRunner();
fake.images.add('dockware/shopware:6.7.15.1');
setRunner(fake);
E.saveSandbox({ enabled: true });
after(async () => { R.resetReconcile(); await fake.close(); await gh.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const until = async (fn: () => boolean, ms = 10_000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 10)); } };
const settled = (id: string) => until(() => !J.setupRunning(id) && T.getTask(id)!.status !== 'setting_up');
const execs = (cid: string) => fake.calls.filter(c => c.op === 'exec' && c.id === cid).map(c => c.argv!);
const NAME = 'CoNineHeaderBanner', DIR = `/var/www/html/custom/plugins/${NAME}`;

const dir = (files: Record<string, string>) => {
  const d = fs.mkdtempSync(path.join(tmp, 'wt-'));
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); }
  return d;
};
const COMPOSER = JSON.stringify({ name: 'conine/header-banner', type: 'shopware-platform-plugin', version: '1.0.0', license: 'MIT', require: { 'shopware/core': '~6.7.0' },
  autoload: { 'psr-4': { 'CoNine\\HeaderBanner\\': 'src/' } }, extra: { 'shopware-plugin-class': `CoNine\\HeaderBanner\\${NAME}`, label: { 'de-DE': 'Header-Banner', 'en-GB': 'Header banner' } } }, null, 2);
const PLUGIN_CLASS = `<?php declare(strict_types=1);\n\nnamespace CoNine\\HeaderBanner;\n\nuse Shopware\\Core\\Framework\\Plugin;\n\nclass ${NAME} extends Plugin\n{\n}\n`;
const TWIG = "{% sw_extends '@Storefront/storefront/layout/header/header.html.twig' %}\n{% block layout_header %}<div class=\"conine-banner\">Gratis Versand ab 50 €</div>{{ parent() }}{% endblock %}\n";

test('helpers: empty listings, suggested names, the name pattern and skip reasons', () => {
  assert.equal(L.isEmptyRepoListing([]), true);
  assert.equal(L.isEmptyRepoListing(['.git', 'README.md', 'LICENSE', '.gitignore', 'readme.rst', '.gitattributes']), true);
  assert.equal(L.isEmptyRepoListing(['README.md', 'index.php']), false);
  assert.equal(L.isEmptyRepoListing(['README.md', 'src']), false);
  assert.equal(L.pluginNameFromRepo('conine/header-banner'), 'HeaderBanner');
  assert.equal(L.pluginNameFromRepo('acme/sw6_shipping.hint'), 'Sw6ShippingHint');
  assert.equal(L.pluginNameFromRepo('acme/2fa'), 'Plugin2fa');
  assert.equal(L.pluginNameFromRepo('acme/-'), '');
  for (const ok of [NAME, 'Ab', `A${'b'.repeat(60)}`]) assert.ok(L.PLUGIN_NAME.test(ok), ok);
  for (const bad of ['coNine', 'A', 'Co-Nine', 'Co Nine', 'Co\\Nine', `A${'b'.repeat(61)}`, 'Ä bc']) assert.ok(!L.PLUGIN_NAME.test(bad), bad);
  const layout = { kind: 'plugin' as const, name: NAME, pluginDir: `custom/plugins/${NAME}`, isNew: true };
  assert.equal(L.skipReason({ dump: null, layout }, { key: 'install-plugin', state: 'pending' }), 'newPlugin');
  assert.equal(L.skipReason({ dump: null, layout }, { key: 'theme-compile', state: 'pending' }), 'newPlugin');
  assert.equal(L.skipReason({ dump: null, layout: { ...layout, isNew: false } }, { key: 'install-plugin', state: 'pending' }), null);
  assert.equal(L.skipReason({ dump: null, layout }, { key: 'import-db', state: 'pending' }), 'noDump');
});

test('detectLayout: an empty repository is a new plugin (chosen or derived name); anything else needs a plugin composer.json', () => {
  const blank = dir({ 'README.md': '# x\n', '.gitignore': 'vendor/\n', LICENSE: 'MIT\n' });
  fs.writeFileSync(path.join(blank, '.git'), 'gitdir: /elsewhere\n'); // the worktree's .git file does not count
  assert.deepEqual(detectLayout(blank, { newPluginName: NAME, repo: 'conine/header-banner' }), { kind: 'plugin', name: NAME, pluginDir: `custom/plugins/${NAME}`, isNew: true });
  assert.equal(detectLayout(blank, { repo: 'conine/header-banner' }).name, 'HeaderBanner', 'derived from the repository name');
  assert.throws(() => detectLayout(blank, { repo: 'conine/-' }), /leer, aber es fehlt ein gültiger technischer Name/);
  assert.throws(() => detectLayout(blank, { newPluginName: 'bad-name', repo: 'conine/-' }), /gültiger technischer Name/);
  assert.throws(() => detectLayout(dir({ 'README.md': '', 'index.php': '<?php' }), { newPluginName: NAME }), /Kein Shopware-Plugin erkannt[\s\S]*leeres Repository/);
  // once composer.json and the class exist, the same folder is an ordinary plugin (the user's name no longer matters)
  const built = dir({ 'README.md': '', 'composer.json': COMPOSER, [`src/${NAME}.php`]: PLUGIN_CLASS });
  assert.deepEqual(detectLayout(built, { newPluginName: 'Other', repo: 'conine/header-banner' }), { kind: 'plugin', name: NAME, pluginDir: `custom/plugins/${NAME}` });
});

test('setup of an empty repository: new plugin, install and theme compile skipped with a note, ready with a container', async () => {
  const t = T.createTask({ chatId: crypto.randomUUID(), title: 'Header-Banner', goal: 'Neues Plugin mit Banner im Header.', repo: 'conine/header-banner', baseBranch: 'main', pluginName: NAME });
  assert.equal(T.publicTask(t).pluginName, NAME);
  J.runSteps(t.id);
  await settled(t.id);
  const done = T.getTask(t.id)!;
  assert.equal(done.status, 'ready', done.error ?? '');
  assert.deepEqual(done.layout, { kind: 'plugin', name: NAME, pluginDir: `custom/plugins/${NAME}`, isNew: true });
  const step = (k: string) => done.steps.find(s => s.key === k)!;
  assert.equal(step('install-plugin').state, 'skipped');
  assert.match(step('install-plugin').log.join('\n'), /plugin:install --activate CoNineHeaderBanner/);
  assert.equal(step('theme-compile').state, 'skipped');
  assert.match(step('detect-layout').log.join('\n'), /Das Repository ist leer – neues Plugin CoNineHeaderBanner/);
  assert.ok(done.containerId && done.containerRunning);
  const argv = execs(done.containerId!);
  assert.ok(!argv.some(a => a.includes('plugin:install') || a.includes('theme:compile') || a.includes('theme:change')), 'nothing installed or compiled');
  assert.deepEqual(argv.find(a => a[0] === 'rm'), ['rm', '-rf', '--', DIR], 'the plugin folder is prepared');
  const arch = fake.archives.filter(a => a.id === done.containerId).at(-1)!;
  assert.equal(arch.dir, '/var/www/html/custom/plugins');
  assert.ok(arch.entries.some(e => e.path === `${NAME}/README.md`));

  // the agent's prompt explains how to build the plugin from scratch
  const before = codeSystemFor(t.id, 'de', false);
  assert.match(before, /neues, noch leeres Plugin namens CoNineHeaderBanner/);
  assert.match(before, /## Neues Plugin aus einem leeren Repository[\s\S]*plugin:install --activate CoNineHeaderBanner/);
  assert.match(before, /## Plugin-Entwicklung[\s\S]*shopware-plugin-class[\s\S]*services\.xml[\s\S]*config\.xml[\s\S]*Migration[\s\S]*build-administration\.sh[\s\S]*plugin:install --activate/);
  assert.match(before, /build-storefront\.sh[^\n]*Internet/);

  // the agent writes composer.json, the class and a template natively; sandbox_bash syncs them first, then installs inside the container
  const wt = T.taskPaths(t.id).worktree;
  const put = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true }); fs.writeFileSync(path.join(wt, rel), text); };
  put('composer.json', COMPOSER); put(`src/${NAME}.php`, PLUGIN_CLASS); put('src/Resources/views/storefront/layout/header/header.html.twig', TWIG);
  const events: ChatEvent[] = [];
  const tools = W.sandboxTools({ id: 'chat-new-plugin', taskId: t.id, emit: ev => { events.push(ev); }, askUser: async () => '', approvals: new Map(), abort: null });
  const cmd = `bin/console plugin:refresh && bin/console plugin:install --activate ${NAME} && bin/console cache:clear`;
  const r = await tools.find(x => x.name === 'sandbox_bash')!.handler({ command: cmd } as any, {});
  assert.ok(!r.isError, JSON.stringify(r.content));
  const synced = fake.archives.filter(a => a.id === done.containerId).at(-1)!;
  for (const f of ['composer.json', `src/${NAME}.php`, 'src/Resources/views/storefront/layout/header/header.html.twig']) assert.ok(synced.entries.some(e => e.path === `${NAME}/${f}`), f);
  assert.deepEqual(execs(done.containerId!).at(-1), ['bash', '-lc', cmd]);
  assert.ok(events.some(e => e.t === 'preview_reload'), 'plugin:install reloads the preview');
  // from now on an ordinary plugin (same folder in the running container), the prompt no longer talks about an empty repository
  assert.deepEqual(T.getTask(t.id)!.layout, { kind: 'plugin', name: NAME, pluginDir: `custom/plugins/${NAME}` });
  assert.doesNotMatch(codeSystemFor(t.id, 'de', false), /Neues Plugin aus einem leeren Repository/);

  // a new setup from "Plugin erkennen" (retry) detects the new plugin and installs it like any other
  J.runSteps(t.id, 'detect-layout');
  await settled(t.id);
  const again = T.getTask(t.id)!;
  assert.equal(again.status, 'ready', again.error ?? '');
  assert.equal(again.steps.find(s => s.key === 'install-plugin')!.state, 'done');
  assert.equal(again.steps.find(s => s.key === 'theme-compile')!.state, 'done');
  assert.ok(execs(again.containerId!).some(a => a.join(' ') === `bin/console plugin:install --activate -- ${NAME}`));
  await J.deleteTask(t.id);
});

test('without a chosen name the plugin is named after the repository', async () => {
  const t = T.createTask({ chatId: crypto.randomUUID(), title: 'Ohne Namen', goal: '', repo: 'conine/header-banner', baseBranch: 'main' });
  J.runSteps(t.id); await settled(t.id);
  const done = T.getTask(t.id)!;
  assert.equal(done.status, 'ready', done.error ?? '');
  assert.equal(done.layout?.name, 'HeaderBanner');
  assert.equal(done.layout?.isNew, true);
  await J.deleteTask(t.id);
});

const post = (body: unknown) => tasksRoute.POST(new Request('http://127.0.0.1/api/sandbox/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
const probe = (q: string) => probeRoute.GET(new Request(`http://127.0.0.1/api/sandbox/repo-probe?${q}`));

test('routes: the probe tells an empty repository with a suggested name; creating validates the technical name', async () => {
  assert.deepEqual(await (await probe('repo=conine/header-banner&branch=main')).json(), { empty: true, suggestedName: 'HeaderBanner' });
  assert.deepEqual(await (await probe('repo=acme/shop-theme&branch=main')).json(), { empty: false, suggestedName: 'ShopTheme' });
  assert.deepEqual(await (await probe('repo=acme/unknown&branch=main')).json(), { empty: null, suggestedName: 'Unknown' }, 'GitHub cannot tell: unknown, no error');
  assert.equal((await probe('repo=../x&branch=main')).status, 400);
  const bad = await post({ chatId: crypto.randomUUID(), repo: 'conine/header-banner', baseBranch: 'main', pluginName: 'header-banner' });
  assert.equal(bad.status, 400);
  assert.match(JSON.stringify(await bad.json()), /Ungültiger Plugin-Name/);
  const res = await post({ chatId: crypto.randomUUID(), repo: 'conine/header-banner', baseBranch: 'main', pluginName: NAME });
  assert.equal(res.status, 201);
  const { task } = await res.json() as any;
  assert.equal(task.pluginName, NAME);
  await settled(task.id);
  assert.equal(T.getTask(task.id)!.layout?.name, NAME);
  await J.deleteTask(task.id);
});

test('start_sandbox: the AI may propose the technical name of a new plugin (validated), shown on the card', async () => {
  const events: ChatEvent[] = [];
  const tool = startSandboxTool({ emit: ev => { events.push(ev); } }) as any;
  const ok = await tool.handler({ repo: 'conine/header-banner', base_branch: 'main', reason: 'Neues Plugin für ein Header-Banner', plugin_name: NAME }, {});
  assert.ok(!ok.isError);
  assert.equal((events.at(-1) as any).pluginName, NAME);
  const bad = await tool.handler({ repo: 'conine/header-banner', reason: 'x', plugin_name: 'header_banner' }, {});
  assert.ok(bad.isError);
  assert.equal(events.length, 1, 'no card for an invalid name');
});

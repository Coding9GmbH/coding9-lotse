import crypto from 'node:crypto';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import '../isolate-data';
import type { ChatEvent } from '@/lib/protocol';
import { PROJECT_CONFIG, makePluginRepo, makeProjectRepo } from '../support/plugin-repo';
import { startFakeGithub } from '../support/github-fake';
/* eslint-disable @typescript-eslint/no-explicit-any -- tool handlers and route contexts take loose input */

// Full Shopware project repositories (A19), mode "Overlay", with the FakeRunner and a bare file:// remote: layout detection, the
// config plan (quarantine, sandbox override, env defaults), the boot check, what is synced (and what never is), installing plugins,
// apps and the theme, edits synced back, publishing rules and the ZIP of one plugin. The plugin repositories keep working as before.
for (const k of ['LOTSE_SANDBOX', 'LOTSE_PASSWORD', 'ALLOWED_HOSTS', 'HOSTNAME', 'HOST', 'AICB_DOCKER', 'LOTSE_BIND', 'LOTSE_SANDBOX_MAX', 'LOTSE_SANDBOX_IDLE_MINUTES', 'LOTSE_SANDBOX_NETWORK', 'LOTSE_SANDBOX_SUBNET', 'LOTSE_SANDBOX_RUNNER']) delete process.env[k];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-project-'));
const shop = makeProjectRepo(tmp, { repo: 'acme/shop' });
makeProjectRepo(tmp, { repo: 'acme/old-shop', version: '6.6.10.4' });
makePluginRepo(tmp, { repo: 'acme/shop-theme', theme: true });
process.env.LOTSE_GITHUB_CLONE_BASE = `file://${shop.remoteBase}`;
const TOKEN = `github_pat_${'Pr0jectRep'.repeat(8)}_abc`;
const gh = await startFakeGithub({ token: TOKEN, repos: [{ fullName: 'acme/shop' }, { fullName: 'acme/old-shop' }, { fullName: 'acme/shop-theme' }] });
process.env.LOTSE_GITHUB_API_BASE = gh.base;

const { FakeRunner, fakeYaml } = await import('../../src/server/sandbox/fake-runner');
const { setRunner } = await import('../../src/server/sandbox/runner');
const { allowFileRemotesForTests } = await import('../../src/server/git');
const { saveGithub } = await import('../../src/server/github');
const { zipEntries } = await import('../../src/server/zip-guard');
const P = await import('../../src/server/sandbox/project');
const E = await import('../../src/server/sandbox/env');
const J = await import('../../src/server/sandbox/jobs');
const T = await import('../../src/server/sandbox/tasks');
const R = await import('../../src/server/sandbox/reconcile');
const W = await import('../../src/server/sandbox/workspace-tools');
const Z = await import('../../src/server/sandbox/plugin-zip');
const { blockReason } = await import('../../src/server/sandbox/publish');
const { detectLayout } = await import('../../src/server/sandbox/templates/dockware');
const { codeSystemFor } = await import('../../src/server/prompt');
const L = await import('../../src/lib/sandbox-task');
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
const execs = (cid: string) => fake.calls.filter(c => c.op === 'exec' && c.id === cid).map(c => c.argv!);
const files = (cid: string) => fake.containers.get(cid)!.files;
const ROOT = '/var/www/html';
const dir = (fx: Record<string, string>) => {
  const d = fs.mkdtempSync(path.join(tmp, 'wt-'));
  for (const [f, c] of Object.entries(fx)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); }
  return d;
};
const seed = path.join(tmp, 'seed-acme-shop');
const RT = { appEnv: 'dev', extensions: ['debug', 'elasticsearch', 'framework', 'monolog', 'shopware', 'storefront', 'twig', 'web_profiler'], envNames: ['APP_ENV', 'APP_URL', 'DATABASE_URL'] };
const parsedOf = (rels: string[], root = seed) => Object.fromEntries(rels.filter(r => /\.ya?ml$/.test(r)).map(r => [r, { data: fakeYaml(fs.readFileSync(path.join(root, r), 'utf8')) }]));
const rawOf = (rels: string[], root = seed) => Object.fromEntries(rels.map(r => [r, fs.readFileSync(path.join(root, r), 'utf8')]));

test('detectLayout: a shopware/production repository is a project with its plugins, apps, config files and Shopware version', () => {
  const l = detectLayout(seed, { repo: 'acme/shop' });
  assert.equal(l.kind, 'project');
  assert.equal(l.name, 'acme/shop');
  assert.equal(l.pluginDir, '');
  const p = l.project!;
  assert.deepEqual(p.plugins.map(x => [x.name, x.dir, !!x.static, !!x.theme]), [
    ['AcmeStorefrontTweaks', 'custom/plugins/AcmeStorefrontTweaks', false, false], ['AcmeTheme', 'custom/plugins/AcmeTheme', false, true],
    ['AcmeErpConnector', 'custom/static-plugins/AcmeErpConnector', true, false]]);
  assert.equal(p.plugins[2].composerName, 'acme/erp-connector');
  assert.deepEqual(p.plugins[1].parts, ['storefront', 'styles']);
  assert.deepEqual(p.plugins[0].parts, ['storefront', 'snippets']);
  assert.deepEqual(p.plugins[2].parts, ['php']);
  assert.deepEqual(p.apps, [{ name: 'AcmeHelloApp', dir: 'custom/apps/AcmeHelloApp' }]);
  assert.equal(p.shopwareVersion, '6.7.15.1');
  assert.equal(p.src, true);
  assert.deepEqual(p.psr4, { 'App\\': 'src/' });
  // config/packages (all environments' folders) and config/services*.yaml; never bundles.php
  assert.deepEqual(p.configFiles, ['config/packages/elasticsearch.yaml', 'config/packages/framework.yaml', 'config/packages/mailer.yaml', 'config/packages/monolog.yaml',
    'config/packages/prod/monolog.yaml', 'config/packages/sentry.yaml', 'config/packages/shopware.yaml', 'config/services.yaml']);
  assert.equal(P.projectSummary(p), '3 Plugins: AcmeStorefrontTweaks, AcmeTheme (Theme), AcmeErpConnector (statisch) · 1 Apps: AcmeHelloApp · 8 Konfigurationsdateien · Projekt-Code in src/ · Shopware 6.7.15.1');
});

test('detectLayout: what is not a Shopware project says so; plugins and empty repositories stay as they were', () => {
  assert.throws(() => detectLayout(dir({ 'composer.json': JSON.stringify({ type: 'project', require: { 'symfony/framework-bundle': '^7' } }), 'bin/console': '' })), /Kein Shopware-Projekt erkannt/);
  assert.throws(() => detectLayout(dir({ 'bin/console': '', 'symfony.lock': '{}' })), /keine composer\.json im Hauptordner/);
  // a project without type "project" still counts when it has the shopware/production layout
  const lib = detectLayout(dir({ 'composer.json': JSON.stringify({ name: 'acme/x', require: { 'shopware/platform': '*' } }), 'config/packages/a.yaml': 'framework: {}\n' }), { repo: 'acme/x' });
  assert.equal(lib.kind, 'project');
  assert.equal(lib.project!.shopwareVersion, null, 'no composer.lock');
  // a plugin requiring shopware/core is no project
  const plugin = detectLayout(path.join(seed, 'custom/plugins/AcmeTheme'));
  assert.deepEqual([plugin.kind, plugin.name, plugin.pluginDir], ['theme', 'AcmeTheme', 'custom/plugins/AcmeTheme']);
  assert.equal(plugin.project, undefined);
});

test('versions: composer.lock against the image tag, major.minor decides, the matching image is suggested', () => {
  assert.equal(P.lockVersion(seed), '6.7.15.1');
  assert.equal(P.imageVersion('dockware/shopware:6.7.15.1'), '6.7.15.1');
  assert.equal(P.imageVersion('dockware/shopware:6.7.15.1-arm64'), '6.7.15.1');
  assert.equal(P.imageVersion('dockware/play:6.7.2.2'), '6.7.2.2');
  assert.equal(P.versionMismatch('6.7.14.0', 'dockware/shopware:6.7.15.1'), null);
  assert.deepEqual(P.versionMismatch('6.6.10.4', 'dockware/shopware:6.7.15.1'), { project: '6.6.10.4', image: '6.7.15.1', suggest: 'dockware/shopware:6.6.10.4' });
  assert.equal(P.versionMismatch(null, 'dockware/shopware:6.7.15.1'), null);
});

test('sync rules: plugin and app folders as units, config/packages, config/services*.yaml and src/ as files, nothing else', () => {
  assert.deepEqual(P.projectSyncPath('custom/plugins/AcmeTheme/src/Resources/theme.json'), { kind: 'unit', unit: 'custom/plugins/AcmeTheme' });
  assert.deepEqual(P.projectSyncPath('custom/static-plugins/AcmeErpConnector/composer.json'), { kind: 'unit', unit: 'custom/static-plugins/AcmeErpConnector' });
  assert.deepEqual(P.projectSyncPath('custom/apps/AcmeHelloApp/manifest.xml'), { kind: 'unit', unit: 'custom/apps/AcmeHelloApp' });
  for (const f of ['config/packages/shopware.yaml', 'config/packages/dev/x.yml', 'config/services.yaml', 'config/services_dev.yaml', 'src/Kernel.php', 'src/Subscriber/A.php'])
    assert.deepEqual(P.projectSyncPath(f), { kind: 'file' }, f);
  for (const f of ['composer.json', 'composer.lock', 'config/bundles.php', 'config/routes.yaml', 'config/jwt/private.pem', '.env', '.env.local', 'config/packages/.env', 'vendor/autoload.php', 'var/cache/x',
    'public/index.php', 'custom/plugins/AcmeTheme/.env', 'custom/plugins/X/node_modules/a.js', 'custom/plugins', 'config/packages/dev/zz_lotse_sandbox.yaml', 'README.md', 'bin/console', 'config/packages/a.txt'])
    assert.equal(P.projectSyncPath(f), null, f);
  assert.ok(P.isProjectConfig('config/packages/shopware.yaml') && P.isProjectConfig('config/services.yaml'));
  assert.ok(!P.isProjectConfig('config/packages/x.php') && !P.isProjectConfig('src/a.yaml'));
  assert.ok(P.loadedIn('config/packages/a.yaml', 'dev') && P.loadedIn('config/packages/dev/a.yaml', 'dev') && P.loadedIn('config/services_dev.yaml', 'dev'));
  assert.ok(!P.loadedIn('config/packages/prod/a.yaml', 'dev') && !P.loadedIn('config/services_prod.yaml', 'dev'));
});

test('config plan: production services switched to local, unknown extensions quarantined, env defaults, override as YAML', () => {
  const rels = Object.keys(PROJECT_CONFIG).filter(f => f !== 'config/bundles.php');
  const plan = P.planConfig(parsedOf(rels), rawOf(rels), RT);
  assert.deepEqual([...plan.quarantine], [['config/packages/sentry.yaml', 'keine Erweiterung für „sentry“ im Image']]);
  const o = plan.override as any;
  assert.equal(o.framework.cache.app, 'cache.adapter.filesystem');
  assert.equal(o.framework.session.handler_id, null);
  assert.equal(o.framework.mailer.dsn, 'smtp://127.0.0.1:1025');
  assert.equal(o.framework.messenger.transports.async.dsn, 'sync://');
  assert.equal(o.framework.messenger.transports.failed, 'doctrine://default?queue_name=failed&auto_setup=false');
  assert.equal(o.shopware.deployment.cluster_setup, false);
  assert.equal(o.shopware.cart.storage.type, 'mysql');
  assert.equal(o.shopware.number_range.increment_storage, 'mysql');
  assert.deepEqual(o.shopware.filesystem.public, { type: 'local', url: '%env(APP_URL)%', config: { root: '%kernel.project_dir%/public' } });
  assert.deepEqual(o.shopware.filesystem.private, { type: 'local', config: { root: '%kernel.project_dir%/files' } });
  assert.equal(o.shopware.cdn.url, '');
  assert.deepEqual(o.elasticsearch, { enabled: false, indexing_enabled: false, throw_exception: false, administration: { enabled: false } });
  assert.deepEqual(o.monolog.handlers, { graylog: { type: 'null' } }, 'only the remote handler; the stream handler stays; prod/ is not loaded in dev');
  // %env()% of loaded files the container does not define; SENTRY_DSN is in a quarantined file
  assert.deepEqual(plan.envDefaults, ['MESSENGER_TRANSPORT_DSN', 'OPENSEARCH_URL', 'REDIS_CACHE_URL', 'REDIS_SESSION_URL', 'S3_PRIVATE_BUCKET', 'S3_PUBLIC_BUCKET', 'SMTP_PASSWORD', 'SMTP_USER']);
  assert.equal(o.parameters['env(S3_PUBLIC_BUCKET)'], '');
  assert.ok(plan.notes.includes('shopware.filesystem.public: amazon-s3 → local'));
  assert.deepEqual(plan.files.map(f => f.rel), ['config/services.yaml', 'config/packages/elasticsearch.yaml', 'config/packages/framework.yaml', 'config/packages/mailer.yaml', 'config/packages/monolog.yaml', 'config/packages/shopware.yaml']);
  const yaml = P.overrideYaml(plan, 'dev');
  assert.match(yaml, /^# Written by Lotse for the sandbox only/);
  assert.match(yaml, /\nframework:\n {4}cache:\n {8}app: 'cache\.adapter\.filesystem'\n/);
  assert.match(yaml, /\n {8}handler_id: ~\n/);
  assert.match(yaml, /\n {4}'env\(SMTP_USER\)': ''\n/);
  assert.match(yaml, /\n {8}graylog:\n {12}type: 'null'\n/);
  assert.match(yaml, /\n {12}url: '%env\(APP_URL\)%'\n/);
  assert.match(yaml, /cluster_setup: false/);
  // the YAML reads back as the same object (the fake's parser is enough for the block mappings)
  assert.equal((fakeYaml(yaml) as any).shopware.cart.storage.type, 'mysql');
  // a project that configures nothing external gets an empty override
  assert.equal(P.overrideYaml(P.planConfig({ 'config/packages/a.yaml': { data: { framework: { secret: 'x' } } } }, {}, RT), 'dev').split('\n').at(-2), '{}');
});

test('config plan: when@<env>, held files, YAML errors, extra env names, quoting', () => {
  const parsed = {
    'config/packages/a.yaml': { data: { 'when@dev': { frosh_tools: {} }, 'when@prod': { sentry: {} }, framework: {} } },
    'config/packages/b.yaml': { data: { 'when@prod': { sentry: { dsn: 'x' } }, framework: { lock: 'redis://x' } } },
    'config/packages/c.yaml': { error: 'Malformed inline YAML string at line 2' },
    'config/packages/d.yaml': { data: { storefront: { htmlPurifier: { cacheEnabled: true } } } },
    'config/packages/prod/e.yaml': { data: { sentry: {} } },
  };
  const plan = P.planConfig(parsed, { 'config/packages/b.yaml': "framework:\n  lock: '%env(LOCK_DSN)%'\n" }, { ...RT, extraEnv: ['FROM_PHP_CONFIG', 'APP_URL'] }, { 'config/packages/d.yaml': 'Shopware startet damit nicht' });
  assert.deepEqual([...plan.quarantine.keys()].sort(), ['config/packages/a.yaml', 'config/packages/c.yaml', 'config/packages/d.yaml']);
  assert.match(plan.quarantine.get('config/packages/a.yaml')!, /frosh_tools/);
  assert.match(plan.quarantine.get('config/packages/c.yaml')!, /^YAML-Fehler: Malformed/);
  assert.equal((plan.override as any).framework.lock, 'flock');
  assert.deepEqual(plan.envDefaults, ['FROM_PHP_CONFIG', 'LOCK_DSN'], 'APP_URL is defined by the container');
  assert.equal(P.toYaml({ a: { 'b.c': "it's", 'env(X)': true, n: 3, l: ['x', 'y'], e: {} } }), "a:\n    b.c: 'it''s'\n    'env(X)': true\n    n: 3\n    l: ['x', 'y']\n    e: {}\n");
});

test('container facts and the boot check: extensions, APP_ENV, env names, the file a boot error points at', () => {
  const debugConfig = `\nAvailable registered bundles with their extension alias if available\n====\n\n ------------------------ ----------------- \n  Bundle name              Extension alias  \n ------------------------ ----------------- \n  Administration                            \n  DebugBundle              debug            \n  Framework                shopware         \n  FrameworkBundle          framework        \n  PentatrionViteBundle     pentatrion_vite  \n  SwagPlatformDemoData                      \n ------------------------ ----------------- \n\n // Provide the name of a bundle as the first argument of this command to dump  \n`;
  assert.deepEqual(P.parseExtensions(debugConfig), ['debug', 'framework', 'pentatrion_vite', 'shopware']);
  assert.equal(P.parseAppEnv('  Kernel\n  Type                 Shopware\\Core\\Kernel\n  Environment          dev    \n  Debug   true'), 'dev');
  assert.equal(P.parseAppEnv('nothing'), 'dev');
  assert.deepEqual(P.parseEnvNames('PATH\nAPP_ENV\nAPP_ENV\nnot a name\n=x\n'), ['APP_ENV', 'PATH']);
  const fx = [
    { rel: 'config/packages/storefront.yaml', data: { storefront: { theme: {}, htmlPurifier: { cacheEnabled: true } } }, raw: '' },
    { rel: 'config/packages/z.yaml', data: { storefront: { theme: {} } }, raw: '' },
    { rel: 'config/services.yaml', data: { services: {} }, raw: "services:\n  Sentry\\SentryBundle\\Client: ~\n" },
  ];
  assert.deepEqual(P.bootFinding('In ArrayNode.php line 1:\n  Unrecognized option "htmlPurifier" under "storefront". Available options are "theme".', fx, 'dev'),
    { file: 'config/packages/storefront.yaml', reason: 'Shopware startet damit nicht: unbekannte Option „htmlPurifier“ unter „storefront“' });
  assert.deepEqual(P.bootFinding('There is no extension able to load the configuration for "storefront" (in …)', fx, 'dev'), { file: 'config/packages/storefront.yaml', reason: 'keine Erweiterung für „storefront“ im Image' });
  assert.deepEqual(P.bootFinding('Environment variable not found: "REDIS_URL".', fx, 'dev'), { env: 'REDIS_URL' });
  assert.deepEqual(P.bootFinding('Attempted to load class "Client" from namespace "Sentry\\SentryBundle".', fx, 'dev'), { file: 'config/services.yaml', reason: 'Shopware startet damit nicht: Klasse Sentry\\SentryBundle\\Client fehlt im Image' });
  assert.equal(P.bootFinding('Something else entirely', fx, 'dev'), null);
  assert.equal(P.bootError('\nIn X.php line 3:\n\n  Unrecognized option "a" under "b"\n'), 'Unrecognized option "a" under "b"');
  assert.deepEqual(P.missingPsr4({ 'App\\': 'src/', 'Acme\\Shop\\': 'src/Shop/', 'Lib\\': 'lib/', 'bad': 'src/' }, { autoload: { 'psr-4': { 'App\\': 'src/' } } }), { add: { 'Acme\\Shop\\': 'src/Shop/' }, skipped: ['Lib\\', 'bad'] });
  assert.deepEqual(P.requiredPackages({ require: { php: '>=8.2', 'ext-intl': '*', 'shopware/core': '*', 'symfony/flex': '*', 'acme/erp-connector': '*', 'frosh/tools': '^3' } }, new Set(['acme/erp-connector'])), ['frosh/tools']);
});

test('publishing a project: its own parts only, never dependencies, build output, secrets or workflows', () => {
  const ok = (p: string) => blockReason([{ path: p, status: 'M' }], 'project');
  for (const p of ['custom/plugins/AcmeTheme/src/Resources/theme.json', 'custom/static-plugins/X/composer.json', 'custom/apps/A/manifest.xml', 'config/packages/shopware.yaml', 'config/bundles.php',
    'src/Subscriber/A.php', 'composer.json', 'composer.lock', 'README.md', 'tests/A.php', 'phpstan.neon.dist'])
    assert.equal(ok(p), null, p);
  assert.match(ok('vendor/autoload.php')!, /Abhängigkeit oder Build-Ausgabe/);
  assert.match(ok('custom/plugins/X/node_modules/a.js')!, /Abhängigkeit oder Build-Ausgabe/);
  assert.match(ok('public/theme/x.css')!, /Abhängigkeit oder Build-Ausgabe/);
  assert.match(ok('var/log/dev.log')!, /Abhängigkeit oder Build-Ausgabe/);
  assert.match(ok('bin/console')!, /außerhalb der Bereiche/);
  assert.match(ok('.env')!, /geschützte Datei/);
  assert.match(ok('config/jwt/private.pem')!, /geschützte Datei/);
  assert.match(ok('.github/workflows/deploy.yml')!, /GitHub-Workflows/);
  // a plugin repository keeps its rules (vendor/ is its own business there)
  assert.equal(blockReason([{ path: 'bin/build.sh', status: 'M' }], 'plugin'), null);
  assert.equal(blockReason([{ path: 'bin/build.sh', status: 'M' }]), null);
});

let projectTask = '';
test('setup of a project: overlay synced (never .env, composer files, bundles.php), config planned, plugins, apps and theme installed', async () => {
  fake.script = argv => (argv[0] === 'bash' && /\[ -d "vendor\/\$p" \]/.test(argv[2] ?? '') ? { output: 'sentry/sentry-symfony\nfrosh/tools\n' } : undefined);
  const t = T.createTask({ chatId: crypto.randomUUID(), title: 'Footer anpassen', goal: 'Footer-Text ändern.', repo: 'acme/shop', baseBranch: 'main' });
  J.runSteps(t.id);
  await settled(t.id);
  fake.script = () => undefined;
  const done = T.getTask(t.id)!;
  assert.equal(done.status, 'ready', done.error ?? '');
  projectTask = t.id;
  const step = (k: string) => done.steps.find(s => s.key === k)!;
  assert.match(step('detect-layout').log.join('\n'), /Shopware-Projekt acme\/shop → \/var\/www\/html[\s\S]*3 Plugins[\s\S]*passt zum Image/);
  const p = done.layout!.project!;
  assert.equal(done.layout!.kind, 'project');
  assert.equal(p.appEnv, 'dev');
  assert.ok(p.extensions!.includes('shopware') && !p.extensions!.includes('sentry'));
  assert.deepEqual(p.quarantined, [{ file: 'config/packages/sentry.yaml', reason: 'keine Erweiterung für „sentry“ im Image' }]);
  assert.ok(p.overrides!.some(o => /cache\.app: cache\.adapter\.redis → cache\.adapter\.filesystem/.test(o)));
  assert.ok(p.overrides!.some(o => /^Umgebungsvariablen ohne Wert in der Sandbox: .*S3_PUBLIC_BUCKET/.test(o)));
  assert.deepEqual(p.missingPackages, ['frosh/tools', 'sentry/sentry-symfony']);
  assert.equal(p.theme, 'AcmeTheme');
  const log = step('install-plugin').log.join('\n');
  assert.match(log, /Nicht geladen: config\/packages\/sentry\.yaml/);
  assert.match(log, /Sandbox-Anpassungen \(config\/packages\/…\/zz_lotse_sandbox\.yaml\): .*shopware\.cart\.storage\.type: redis → mysql/);
  assert.match(log, /Warnung: Diese Pakete verlangt das Projekt, sie fehlen aber im Image[^\n]*frosh\/tools, sentry\/sentry-symfony/);
  assert.match(log, /Shopware startet mit der Konfiguration des Projekts ✓/);
  assert.match(log, /Plugins installiert und aktiv: AcmeStorefrontTweaks, AcmeTheme, AcmeErpConnector/);
  assert.match(log, /App AcmeHelloApp installiert und aktiv/);
  assert.match(log, /Theme AcmeTheme der Storefront zugewiesen/);

  const cid = done.containerId!, argv = execs(cid);
  const has = (pred: (a: string[]) => boolean) => argv.some(pred);
  assert.ok(has(a => a.join(' ') === 'bin/console plugin:install --activate -n -- AcmeStorefrontTweaks AcmeTheme AcmeErpConnector'), 'one call with all names');
  assert.ok(has(a => a.join(' ') === 'bin/console app:install --activate --force -n -- AcmeHelloApp'));
  assert.ok(has(a => a.join(' ') === 'bin/console theme:change --all --no-compile -n -- AcmeTheme'));
  assert.ok(has(a => a.join(' ') === 'env COMPOSER_DISABLE_NETWORK=1 COMPOSER_NO_INTERACTION=1 composer require --no-scripts --no-plugins --no-interaction --no-progress -- acme/erp-connector:*@dev'));
  const prep = argv.findIndex(a => a[0] === 'php' && a.includes('prepare')), req = argv.findIndex(a => a.includes('require')), back = argv.findIndex(a => a[0] === 'php' && a.includes('restore'));
  assert.ok(prep >= 0 && prep < req && req < back, 'composer.json prepared, required, restored');
  assert.ok(has(a => a.join(' ') === 'bin/console cache:pool:clear --all'), 'the HTTP cache too');
  assert.ok(has(a => a[0] === 'php' && a[2].includes('PARSE_CUSTOM_TAGS') && a.includes('config/packages/shopware.yaml')), 'the config parsed in the container');

  // what is in the container: the overlay, Lotse's override and list; never secrets, composer files, bundles.php, public/, var/ content
  const fsys = files(cid);
  for (const f of ['custom/plugins/AcmeTheme/src/Resources/theme.json', 'custom/static-plugins/AcmeErpConnector/composer.json', 'custom/apps/AcmeHelloApp/manifest.xml',
    'config/packages/shopware.yaml', 'config/packages/prod/monolog.yaml', 'config/services.yaml', 'src/Subscriber/ProjectHeaderSubscriber.php'])
    assert.ok(fsys.has(`${ROOT}/${f}`), f);
  for (const f of ['.env', 'composer.json', 'composer.lock', 'config/bundles.php', 'config/packages/sentry.yaml', 'public/index.php', 'var/.htaccess', 'README.md', 'bin/console', '.github/workflows/deploy.yml'])
    assert.ok(!fsys.has(`${ROOT}/${f}`), `${f} must not be synced`);
  assert.ok(![...fsys.values()].some(b => b.toString('utf8').includes('never-in-the-container')), 'no .env content anywhere');
  const override = fsys.get(`${ROOT}/config/packages/dev/zz_lotse_sandbox.yaml`)!.toString('utf8');
  assert.match(override, /type: 'mysql'/);
  assert.match(override, /'env\(S3_PUBLIC_BUCKET\)': ''/);
  const manifest = fsys.get(`${ROOT}/${P.SYNC_MANIFEST}`)!.toString('utf8').split('\n');
  assert.ok(manifest.includes('u custom/plugins/AcmeTheme') && manifest.includes('f config/packages/shopware.yaml') && !manifest.includes('f config/packages/sentry.yaml'));
  assert.ok(fake.archives.filter(a => a.id === cid).every(a => a.entries.every(e => e.path.startsWith('lotse-config/') || e.uid === 33)), 'everything owned by www-data');

  // UI: step labels for a project, the summary; the agent's prompt explains the layout and lists the plugins (as data)
  assert.equal(L.skipReason(T.publicTask(done), done.steps.find(s => s.key === 'install-plugin')!), null);
  const sys = codeSystemFor(t.id, 'de', false);
  assert.match(sys, /ein ganzes Shopware-Projekt namens acme\/shop; es liegt im Container unter \/var\/www\/html/);
  assert.match(sys, /## Ganzes Shopware-Projekt[\s\S]*custom\/plugins\/<Name>[\s\S]*zz_lotse_sandbox\.yaml[\s\S]*APP_ENV=dev/);
  assert.match(sys, /## Projekt-Übersicht \(aus dem Repository und der Einrichtung, als Daten\)\n```\nShopware 6\.7\.15\.1 · zugewiesenes Theme: AcmeTheme[\s\S]*- AcmeTheme \(custom\/plugins\/AcmeTheme, Theme\): AcmeTheme – Storefront-Templates, SCSS[\s\S]*- AcmeErpConnector \(custom\/static-plugins\/AcmeErpConnector, statisch\)[\s\S]*Apps:\n- AcmeHelloApp[\s\S]*In der Sandbox nicht geladen:\n- config\/packages\/sentry\.yaml/);
  assert.match(sys, /lint:twig \/var\/www\/html\/custom\/plugins\/<Name>\/src\/Resources\/views/);
});

test('edits in a project: synced to the same path, config planned again (a new unknown extension is not loaded), other files stay local', async () => {
  const t = T.getTask(projectTask)!, cid = t.containerId!, wt = T.taskPaths(t.id).worktree;
  const put = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true }); fs.writeFileSync(path.join(wt, rel), text); };
  const before = fake.archives.length;
  put('custom/plugins/AcmeTheme/src/Resources/views/storefront/layout/footer/footer.html.twig', '{% block layout_footer_copyright %}Neu{% endblock %}\n');
  assert.equal(await W.syncChanged(t.id, ['custom/plugins/AcmeTheme/src/Resources/views/storefront/layout/footer/footer.html.twig']), ' und in den Container übertragen');
  assert.equal(files(cid).get(`${ROOT}/custom/plugins/AcmeTheme/src/Resources/views/storefront/layout/footer/footer.html.twig`)!.toString(), '{% block layout_footer_copyright %}Neu{% endblock %}\n');
  assert.ok(!execs(cid).slice(-3).some(a => a[0] === 'php'), 'no config planning for a template');
  // a config file gaining an extension the image lacks: not loaded, removed from the container, the agent is told
  put('config/packages/framework.yaml', "framework:\n    cache:\n        app: cache.adapter.redis\nfrosh_tools:\n    x: 1\n");
  const note = await W.syncChanged(t.id, ['config/packages/framework.yaml']);
  assert.match(note, /in der Sandbox NICHT geladen: config\/packages\/framework\.yaml \(keine Erweiterung für „frosh_tools“ im Image\)/);
  assert.ok(!files(cid).has(`${ROOT}/config/packages/framework.yaml`));
  assert.ok(T.getTask(t.id)!.layout!.project!.quarantined!.some(q => q.file === 'config/packages/framework.yaml'));
  put('config/packages/framework.yaml', "framework:\n    cache:\n        app: cache.adapter.redis\n");
  assert.equal(await W.syncChanged(t.id, ['config/packages/framework.yaml']), ' und in den Container übertragen');
  assert.ok(files(cid).has(`${ROOT}/config/packages/framework.yaml`));
  assert.match(files(cid).get(`${ROOT}/config/packages/dev/zz_lotse_sandbox.yaml`)!.toString(), /app: 'cache\.adapter\.filesystem'/);
  // outside the synced parts: nothing to transfer; a deleted plugin file is deleted in the container
  put('README.md', '# changed\n'); put('composer.json', '{"name":"acme/shop","type":"project","require":{"shopware/core":"*"}}');
  const n = fake.archives.length;
  await W.syncChanged(t.id, ['README.md', 'composer.json']);
  assert.equal(fake.archives.length, n, 'nothing uploaded');
  fs.rmSync(path.join(wt, 'custom/plugins/AcmeStorefrontTweaks/src/Resources/snippet/storefront.de-DE.json'));
  await W.syncChanged(t.id, ['custom/plugins/AcmeStorefrontTweaks/src/Resources/snippet/storefront.de-DE.json']);
  assert.ok(!files(cid).has(`${ROOT}/custom/plugins/AcmeStorefrontTweaks/src/Resources/snippet/storefront.de-DE.json`));
  assert.ok(fake.archives.length > before);

  // sandbox_bash: a full sync first; a plugin folder removed meanwhile disappears from the container (the list of the last sync)
  fs.rmSync(path.join(wt, 'custom/apps/AcmeHelloApp'), { recursive: true });
  const events: ChatEvent[] = [];
  const tools = W.sandboxTools({ id: 'chat-project', taskId: t.id, emit: ev => { events.push(ev); }, askUser: async () => '', approvals: new Map(), abort: null });
  const r = await tools.find(x => x.name === 'sandbox_bash')!.handler({ command: 'bin/console plugin:list' } as any, {});
  assert.ok(!r.isError, JSON.stringify(r.content));
  assert.ok(![...files(cid).keys()].some(k => k.startsWith(`${ROOT}/custom/apps/AcmeHelloApp/`)), 'stale app folder removed');
  assert.ok(files(cid).has(`${ROOT}/custom/plugins/AcmeTheme/src/Resources/theme.json`));
  const env = await tools.find(x => x.name === 'get_environment')!.handler({} as any, {});
  const data = JSON.parse((env.content[0] as { text: string }).text);
  assert.equal(data.containerPath, '/var/www/html');
  assert.equal(data.layout.kind, 'project');
});

test('ZIP of one plugin of a project: chosen by folder, only that folder; unknown folders refused', async () => {
  const t = T.getTask(projectTask)!;
  const c = Z.checkPluginZip(t);
  assert.deepEqual(c.plugins, [{ dir: 'custom/plugins/AcmeStorefrontTweaks', name: 'AcmeStorefrontTweaks' }, { dir: 'custom/plugins/AcmeTheme', name: 'AcmeTheme' }, { dir: 'custom/static-plugins/AcmeErpConnector', name: 'AcmeErpConnector' }]);
  assert.equal(c.plugin, 'custom/plugins/AcmeStorefrontTweaks', 'the first by default');
  const theme = Z.checkPluginZip(t, 'custom/plugins/AcmeTheme');
  assert.equal(theme.ok, true, JSON.stringify(theme.problems));
  assert.equal(theme.name, 'AcmeTheme');
  assert.throws(() => Z.checkPluginZip(t, 'custom/plugins/Nope'), /gibt es im Projekt nicht/);
  const res = await zipRoute.GET(new Request(`http://127.0.0.1/api/sandbox/tasks/${t.id}/plugin-zip?plugin=${encodeURIComponent('custom/plugins/AcmeTheme')}`), { params: Promise.resolve({ id: t.id }) });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') ?? '', /AcmeTheme-1\.0\.0\.zip/);
  const buf = Buffer.from(await res.arrayBuffer());
  const names = zipEntries(buf).map(e => e.name);
  assert.ok(names.includes('AcmeTheme/composer.json') && names.includes('AcmeTheme/src/Resources/theme.json'));
  assert.ok(names.every(n => n.startsWith('AcmeTheme/')), 'only the plugin folder');
  assert.ok(zlib && names.length > 3);
  const bad = await zipRoute.GET(new Request(`http://127.0.0.1/api/sandbox/tasks/${t.id}/plugin-zip?check=1&plugin=..%2Fetc`), { params: Promise.resolve({ id: t.id }) });
  assert.equal(bad.status, 400);
  // a plugin repository has no choice
  assert.equal(Z.zipChoices({ ...t, layout: { kind: 'plugin', name: 'X', pluginDir: 'custom/plugins/X' } }), null);
});

test('a project on another Shopware minor stops at detect-layout until "Trotzdem fortfahren"', async () => {
  const t = T.createTask({ chatId: crypto.randomUUID(), title: 'Alter Shop', repo: 'acme/old-shop', baseBranch: 'main' });
  J.runSteps(t.id);
  await settled(t.id);
  let cur = T.getTask(t.id)!;
  assert.equal(cur.status, 'failed');
  const det = cur.steps.find(s => s.key === 'detect-layout')!;
  assert.equal(det.state, 'failed');
  assert.match(det.error!, /Shopware 6\.6\.10\.4, das Image enthält 6\.7\.15\.1 – passendes Image \(dockware\/shopware:6\.6\.10\.4\)/);
  assert.deepEqual(T.publicTask(cur).layout!.project!.versionMismatch, { project: '6.6.10.4', image: '6.7.15.1', suggest: 'dockware/shopware:6.6.10.4' });
  assert.equal(cur.containerId, null, 'no container yet');
  J.runSteps(t.id, det.id, { ignoreVersion: true });
  await settled(t.id);
  cur = T.getTask(t.id)!;
  assert.equal(cur.status, 'ready', cur.error ?? '');
  assert.ok(cur.ignoreProjectVersion);
  assert.match(cur.steps.find(s => s.key === 'detect-layout')!.log.join('\n'), /„Trotzdem fortfahren“ gewählt/);
  await J.finishTask(t.id);
});

test('the boot check takes out the file Shopware names, defines missing env vars, and stops with the likely file otherwise', async () => {
  // the boot check clears the cache before each `about` (the first `about` reads the clean image)
  const cleared = new Set<string>();
  const afterClear = (argv: readonly string[], id: string) => {
    if (argv[0] === 'bash' && argv[2] === 'rm -rf var/cache/* 2>/dev/null; exit 0') { cleared.add(id); return false; }
    if (argv[0] === 'bin/console' && argv[1] === 'about' && cleared.delete(id)) return true;
    return false;
  };
  let round = 0;
  fake.script = (argv, id) => {
    if (afterClear(argv, id)) {
      round++;
      if (round === 1) return { exitCode: 1, output: 'In ArrayNode.php line 1:\n  Unrecognized option "lock" under "framework". Available options are …' };
      if (round === 2) return { exitCode: 1, output: 'Environment variable not found: "FROM_PHP".' };
    }
    return undefined;
  };
  const t = T.createTask({ chatId: crypto.randomUUID(), title: 'Boot', repo: 'acme/shop', baseBranch: 'main' });
  J.runSteps(t.id);
  await settled(t.id);
  let cur = T.getTask(t.id)!;
  assert.equal(cur.status, 'ready', cur.error ?? '');
  const log = cur.steps.find(s => s.key === 'install-plugin')!.log.join('\n');
  assert.match(log, /Shopware startet nicht \(Unrecognized option "lock" under "framework"[^\n]*\) – config\/packages\/framework\.yaml wird in der Sandbox nicht geladen/);
  assert.match(log, /Umgebungsvariable FROM_PHP fehlt – in der Sandbox leer gesetzt/);
  assert.match(log, /Shopware startet nach 2 Anpassung\(en\) ✓/);
  assert.deepEqual(cur.layout!.project!.held, [{ file: 'config/packages/framework.yaml', reason: 'Shopware startet damit nicht: unbekannte Option „lock“ unter „framework“' }]);
  assert.match(files(cur.containerId!).get(`${ROOT}/config/packages/dev/zz_lotse_sandbox.yaml`)!.toString(), /'env\(FROM_PHP\)': ''/);
  assert.ok(!files(cur.containerId!).has(`${ROOT}/config/packages/framework.yaml`));
  await J.finishTask(t.id);

  // nothing to take out: the step fails with Shopware's line and the likely file
  fake.script = (argv, id) => (afterClear(argv, id) ? { exitCode: 1, output: 'Invalid Redis DSN: "persistent" connection missing' } : undefined);
  const t2 = T.createTask({ chatId: crypto.randomUUID(), title: 'Boot 2', repo: 'acme/shop', baseBranch: 'main' });
  J.runSteps(t2.id);
  await settled(t2.id);
  fake.script = () => undefined;
  cur = T.getTask(t2.id)!;
  assert.equal(cur.status, 'failed');
  assert.match(cur.error!, /Shopware startet mit der Konfiguration des Projekts nicht: Invalid Redis DSN: "persistent" connection missing\nWahrscheinliche Ursache: config\/packages\/shopware\.yaml/);
  await J.finishTask(t2.id);
});

test('with a dump the dump decides: only plugins it does not know are installed, its theme stays', async () => {
  const D = await import('../../src/server/sandbox/dumps');
  const sql = '-- MySQL dump\nINSERT INTO `migration` VALUES (\'Shopware\\\\Core\\\\Migration\\\\V6_7\\\\Migration1700000000X\',1);\n';
  const up = D.createDump('shop.sql', Buffer.byteLength(sql));
  await D.appendChunk(up.id, 0, (await import('node:stream')).Readable.from([Buffer.from(sql)]));
  await D.completeDump(up.id);
  fake.script = argv => {
    if (argv[0] === 'mysql' && argv.at(-1)!.startsWith('SELECT name, active, path FROM plugin')) return { output: 'AcmeTheme\t1\tcustom/plugins/AcmeTheme\nSwagPayPal\t1\tcustom/plugins/SwagPayPal\n' };
    if (argv[0] === 'bash' && argv[2]?.includes('[ -e "$p" ]')) return { output: 'custom/plugins/SwagPayPal\n' };
    if (argv[0] === 'mysql' && argv.at(-1) === 'SELECT name FROM app') return { output: 'AcmeHelloApp\n' };
    return undefined;
  };
  const t = T.createTask({ chatId: crypto.randomUUID(), title: 'Mit Dump', repo: 'acme/shop', baseBranch: 'main', dumpId: up.id });
  J.runSteps(t.id, undefined, { ignoreVersion: true });
  await settled(t.id);
  fake.script = () => undefined;
  const cur = T.getTask(t.id)!;
  assert.equal(cur.status, 'ready', cur.error ?? '');
  const log = cur.steps.find(s => s.key === 'install-plugin')!.log.join('\n');
  assert.match(log, /Im Dump aktiv, aber ohne Code im Projekt oder Image: SwagPayPal/);
  assert.match(log, /1 Projekt-Plugins sind darin bekannt und behalten ihren Zustand, neu installiert: AcmeStorefrontTweaks, AcmeErpConnector/);
  assert.match(log, /Theme: bleibt, wie es im Datenbank-Dump zugewiesen ist/);
  const argv = execs(cur.containerId!);
  assert.ok(argv.some(a => a.join(' ') === 'bin/console plugin:install --activate -n -- AcmeStorefrontTweaks AcmeErpConnector'));
  assert.ok(!argv.some(a => a.includes('theme:change')), 'the dump keeps its theme');
  assert.ok(!argv.some(a => a.includes('app:install')), 'the app is in the dump already');
  assert.equal(cur.layout!.project!.theme, null);
  await J.finishTask(t.id);
});

test('plugin repositories are unchanged: synced to custom/plugins/<Name>, never the project override', async () => {
  process.env.LOTSE_GITHUB_CLONE_BASE = `file://${shop.remoteBase}`;
  const t = T.createTask({ chatId: crypto.randomUUID(), title: 'Theme', repo: 'acme/shop-theme', baseBranch: 'main' });
  J.runSteps(t.id);
  await settled(t.id);
  const cur = T.getTask(t.id)!;
  assert.equal(cur.status, 'ready', cur.error ?? '');
  assert.equal(cur.layout!.kind, 'theme');
  const argv = execs(cur.containerId!);
  assert.ok(argv.some(a => a.join(' ') === 'bin/console plugin:install --activate -- AcmeTheme'));
  assert.ok(!argv.some(a => a[0] === 'php' || a.includes('cache:pool:clear') || a.includes('composer')), 'no project steps');
  assert.ok(fake.archives.filter(a => a.id === cur.containerId).every(a => a.dir === '/var/www/html/custom/plugins' || a.dir === '/var/www'));
  assert.ok(![...files(cur.containerId!).keys()].some(k => k.includes('zz_lotse_sandbox')));
  await J.finishTask(t.id);
});

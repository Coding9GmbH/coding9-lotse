import crypto from 'node:crypto';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../isolate-data';
import { makeProjectRepo } from '../support/plugin-repo';
import { startFakeGithub } from '../support/github-fake';

// Full Shopware project repositories installed completely (the default): the whole repository in /var/www/html, the setup waiting for
// a human to allow internet, composer install with internet and offline again right after, config checked against the installed
// project, database migrated, plugins installed; a failed composer install (missing credentials) ends internet too; the overlay
// fallback and the repository file's "projectInstall". Overlay itself: sandbox-project.test.ts.
for (const k of ['LOTSE_SANDBOX', 'LOTSE_PASSWORD', 'ALLOWED_HOSTS', 'HOSTNAME', 'HOST', 'AICB_DOCKER', 'LOTSE_BIND', 'LOTSE_SANDBOX_MAX', 'LOTSE_SANDBOX_IDLE_MINUTES', 'LOTSE_SANDBOX_NETWORK', 'LOTSE_SANDBOX_SUBNET', 'LOTSE_SANDBOX_RUNNER']) delete process.env[k];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-project-full-'));
const shop = makeProjectRepo(tmp, { repo: 'acme/shop' });
makeProjectRepo(tmp, { repo: 'acme/overlay-shop', files: { '.lotse/sandbox.json': JSON.stringify({ projectInstall: 'overlay' }) } });
process.env.LOTSE_GITHUB_CLONE_BASE = `file://${shop.remoteBase}`;
const TOKEN = `github_pat_${'Fu11Instal'.repeat(8)}_abc`;
const gh = await startFakeGithub({ token: TOKEN, repos: [{ fullName: 'acme/shop' }, { fullName: 'acme/overlay-shop' }] });
process.env.LOTSE_GITHUB_API_BASE = gh.base;

const { FakeRunner } = await import('../../src/server/sandbox/fake-runner');
const { setRunner } = await import('../../src/server/sandbox/runner');
const { allowFileRemotesForTests } = await import('../../src/server/git');
const { saveGithub } = await import('../../src/server/github');
const P = await import('../../src/server/sandbox/project');
const E = await import('../../src/server/sandbox/env');
const J = await import('../../src/server/sandbox/jobs');
const T = await import('../../src/server/sandbox/tasks');
const R = await import('../../src/server/sandbox/reconcile');
const I = await import('../../src/server/sandbox/internet');
const { parseRepoFile } = await import('../../src/server/sandbox/repo-config');
const { COMPOSER_INSTALL, composerHint } = await import('../../src/server/sandbox/templates/dockware-project');
const { codeSystemFor } = await import('../../src/server/prompt');
const L = await import('../../src/lib/sandbox-task');

allowFileRemotesForTests(true);
saveGithub({ token: TOKEN });
const fake = new FakeRunner();
fake.images.add('dockware/shopware:6.7.15.1');
setRunner(fake);
E.saveSandbox({ enabled: true, internet: 'approval' });
after(async () => { R.resetReconcile(); await fake.close(); await gh.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const until = async (fn: () => boolean, ms = 10_000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 10)); } };
const settled = (id: string) => until(() => !J.setupRunning(id) && T.getTask(id)!.status !== 'setting_up');
const ops = (cid: string) => fake.calls.filter(c => c.id === cid);
const files = (cid: string) => fake.containers.get(cid)!.files;
const isComposerInstall = (a: readonly string[] | undefined) => JSON.stringify(a) === JSON.stringify(COMPOSER_INSTALL);
const ROOT = '/var/www/html';
const start = (repo: string) => {
  const t = T.createTask({ chatId: crypto.randomUUID(), title: 'Ganzer Shop', goal: '', repo, baseBranch: 'main' });
  J.runSteps(t.id);
  return t.id;
};

test('projectSyncPath installed completely: every file of the repository but secrets, vendor/, var/, generated public/ folders and config/jwt', () => {
  for (const f of ['composer.json', 'composer.lock', 'symfony.lock', 'config/bundles.php', 'config/routes.yaml', 'bin/console', 'public/index.php', 'public/.htaccess', 'README.md', 'src/Kernel.php', 'config/packages/shopware.yaml'])
    assert.deepEqual(P.projectSyncPath(f, true), { kind: 'file' }, f);
  assert.deepEqual(P.projectSyncPath('custom/plugins/AcmeTheme/composer.json', true), { kind: 'unit', unit: 'custom/plugins/AcmeTheme' });
  for (const f of ['vendor/autoload.php', 'var/cache/x', 'files/x.pdf', 'public/bundles/x.js', 'public/theme/x.css', 'public/media/a.jpg', 'public/thumbnail/a.jpg', 'config/jwt/public.pem', '.lotse/sandbox.json', '.env', '.env.local', 'auth.json', 'node_modules/x/y.js', '.git/config'])
    assert.equal(P.projectSyncPath(f, true), null, f);
  // overlay stays as it was
  assert.equal(P.projectSyncPath('composer.json'), null);
  assert.equal(P.projectSyncPath('bin/console'), null);
});

test('repository file: "projectInstall" is full or overlay, only for a project', () => {
  assert.equal(parseRepoFile(Buffer.from(JSON.stringify({ projectInstall: 'overlay' }))).projectInstall, 'overlay');
  assert.equal(parseRepoFile(Buffer.from(JSON.stringify({ mode: 'project', projectInstall: 'full' }))).projectInstall, 'full');
  assert.throws(() => parseRepoFile(Buffer.from(JSON.stringify({ projectInstall: 'half' }))), /projectInstall/);
  assert.throws(() => parseRepoFile(Buffer.from(JSON.stringify({ mode: 'plugin', projectInstall: 'full' }))), /„projectInstall“ gilt nur mit "mode": "project"/);
});

test('composerHint names the likely cause', () => {
  assert.match(composerHint('  The "https://packages.shopware.com/packages.json" file could not be downloaded (HTTP/2 401 )'), /COMPOSER_AUTH/);
  assert.match(composerHint('curl error 6 while downloading https://repo.packagist.org/packages.json: Could not resolve host: repo.packagist.org'), /Internet/);
  assert.match(composerHint('  - Root composer.json requires php >=8.4 but your php version (8.3.12) does not satisfy that requirement.'), /PHP-Version/);
  assert.equal(composerHint('something else'), '');
});

let fullTask = '';
test('installed completely: the whole repository synced, the setup waits for internet, composer install online, offline again, then migrated and installed', async () => {
  const id = start('acme/shop');
  fullTask = id;
  await until(() => !!T.getTask(id)?.awaitingInternet, 20_000);
  const waiting = T.publicTask(T.getTask(id)!);
  assert.equal(waiting.awaitingInternet, true);
  assert.equal(L.displayStatus(waiting), 'internet');
  assert.equal(L.statusTone(L.displayStatus(waiting)), 'wait');
  const cid = T.getTask(id)!.containerId!;
  assert.ok(!ops(cid).some(c => isComposerInstall(c.argv)), 'nothing installed before the click');
  // the whole repository is in the container already – never secrets, vendor/ or var/; checked config waits for the runtime
  const before = files(cid);
  for (const f of ['composer.json', 'composer.lock', 'config/bundles.php', 'bin/console', 'public/index.php', 'README.md', 'custom/plugins/AcmeTheme/src/Resources/theme.json', 'src/Subscriber/ProjectHeaderSubscriber.php'])
    assert.ok(before.has(`${ROOT}/${f}`), f);
  for (const f of ['.env', 'var/.htaccess', 'config/packages/shopware.yaml', 'config/services.yaml']) assert.ok(!before.has(`${ROOT}/${f}`), `${f} not (yet) synced`);
  assert.ok(![...before.values()].some(b => b.toString('utf8').includes('never-in-the-container')), 'no .env content anywhere');

  await I.grantInternet(id, { via: 'panel', reason: 'composer install' });
  await settled(id);
  const done = T.getTask(id)!;
  assert.equal(done.status, 'ready', done.error ?? '');
  assert.equal(done.internet ?? null, null, 'offline again');
  assert.ok(!done.awaitingInternet);
  assert.ok(!fake.containers.get(cid)!.networks.includes('lotse-sandbox-egress'));
  assert.equal(done.layout!.project!.install, 'full');
  // order: attached → composer install → detached → runtime of the installed project → config synced → migrated → plugins
  const seq: string[] = ops(cid).map(c => (c.op === 'connectEgress' ? 'online' : c.op === 'disconnectEgress' ? 'offline' : isComposerInstall(c.argv) ? 'composer'
    : c.argv?.join(' ') === 'bin/console database:migrate --all -n' ? 'migrate' : c.argv?.[1] === 'plugin:install' ? 'plugins' : '')).filter(Boolean);
  const first = (k: string) => seq.indexOf(k);
  assert.ok(first('online') < first('composer') && first('composer') < seq.indexOf('offline', first('composer')) && first('composer') < first('migrate') && first('migrate') < first('plugins'), seq.join(' → '));
  assert.ok(!ops(cid).some(c => c.argv?.includes('COMPOSER_DISABLE_NETWORK=1')), 'no offline composer of the overlay');
  const now = files(cid);
  assert.ok(now.has(`${ROOT}/config/packages/shopware.yaml`) && now.has(`${ROOT}/config/services_dev.yml`), 'config synced with the override once the runtime is known');
  const log = done.steps.find(s => s.key === 'install-plugin')!.log.join('\n');
  assert.match(log, /Warte auf Internet für composer install/);
  assert.match(log, /Internet wieder gesperrt/);
  assert.match(log, /Shopware des Projekts: Umgebung dev/);
  assert.match(log, /Datenbank auf den Stand des Projekts migriert/);
  assert.match(done.steps.find(s => s.key === 'detect-layout')!.log.join('\n'), /vollständig: das ganze Repository, composer install nach deiner Internet-Freigabe/);
  // the agent learns the mode
  const sys = codeSystemFor(id, 'de', false);
  assert.match(sys, /## Ganzes Shopware-Projekt \(vollständig installiert\)/);
  assert.match(sys, /Shopware 6\.7\.15\.1 · vollständig installiert/);
});

test('installed completely: edits outside the overlay areas (composer.json, bin/) are synced too', async () => {
  const t = T.getTask(fullTask)!, wt = T.taskPaths(t.id).worktree;
  const { syncTaskPaths } = await import('../../src/server/sandbox/task-sync');
  fs.writeFileSync(path.join(wt, 'bin/build.sh'), '#!/bin/sh\necho build\n');
  fs.writeFileSync(path.join(wt, '.env.local'), 'SECRET=x\n');
  await syncTaskPaths(t, ['bin/build.sh']);
  assert.equal(files(t.containerId!).get(`${ROOT}/bin/build.sh`)?.toString(), '#!/bin/sh\necho build\n');
  await assert.rejects(syncTaskPaths(t, ['.env.local']), /nicht übertragen/);
});

test('"immer an": composer install does not wait for a click; offline during the rest of the setup, online once ready', async () => {
  E.saveSandbox({ enabled: true, internet: 'always' });
  try {
    const id = start('acme/shop');
    await settled(id);
    const done = T.getTask(id)!;
    assert.equal(done.status, 'ready', done.error ?? '');
    const seq = ops(done.containerId!).map(c => (c.op === 'connectEgress' ? 'online' : c.op === 'disconnectEgress' ? 'offline' : isComposerInstall(c.argv) ? 'composer' : c.argv?.join(' ') === 'bin/console database:migrate --all -n' ? 'migrate' : '')).filter(Boolean);
    const composer = seq.indexOf('composer');
    assert.ok(seq.lastIndexOf('online', composer) >= 0 && seq.indexOf('offline', composer) < seq.indexOf('migrate'), seq.join(' → '));
    assert.equal(seq.at(-1), 'online', 'online once ready');
    assert.equal(done.internet?.via, 'policy');
    assert.match(done.steps.find(s => s.key === 'install-plugin')!.log.join('\n'), /Internet für composer install \(„immer an“\)/);
    await J.finishTask(id);
  } finally { E.saveSandbox({ enabled: true, internet: 'approval' }); }
});

test('switching to "immer an" while a setup waits for internet lets it go on', async () => {
  const id = start('acme/shop');
  await until(() => !!T.getTask(id)?.awaitingInternet, 20_000);
  const envRoute = await import('../../src/app/api/sandbox/env/route');
  try {
    const res = await envRoute.PUT(new Request('http://127.0.0.1/api/sandbox/env', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ internet: 'always' }) }));
    assert.equal(res.status, 200);
    await settled(id);
    assert.equal(T.getTask(id)!.status, 'ready', T.getTask(id)!.error ?? '');
    await J.finishTask(id);
  } finally { E.saveSandbox({ enabled: true, internet: 'approval' }); }
});

test('a theme without its built storefront JavaScript: the storefront build runs after internet was allowed, offline again after', async () => {
  const { BUILD_STOREFRONT } = await import('../../src/server/sandbox/templates/dockware');
  let compiles = 0;
  fake.script = argv => (argv[0] === 'bin/console' && argv[1] === 'theme:compile' && ++compiles === 1
    ? { exitCode: 1, output: 'Unable to compile the theme "AcmeTheme". Unable to load file "Resources/app/storefront/dist/storefront/js/acme-theme/acme-theme.js". Did you forget to build the theme? Try running ./bin/build-storefront.sh' }
    : undefined);
  const id = start('acme/shop');
  try {
    await until(() => !!T.getTask(id)?.awaitingInternet, 20_000);
    await I.grantInternet(id, { via: 'panel' }); // composer install
    await until(() => T.getTask(id)?.steps.find(s => s.key === 'theme-compile')?.state === 'running' && !!T.getTask(id)?.awaitingInternet, 20_000);
    const cid = T.getTask(id)!.containerId!;
    assert.ok(!ops(cid).some(c => JSON.stringify(c.argv) === JSON.stringify(BUILD_STOREFRONT)), 'no build before the click');
    await I.grantInternet(id, { via: 'panel' }); // storefront build
    await settled(id);
    const done = T.getTask(id)!;
    assert.equal(done.status, 'ready', done.error ?? '');
    const seq = ops(cid).map(c => (c.op === 'connectEgress' ? 'online' : c.op === 'disconnectEgress' ? 'offline' : JSON.stringify(c.argv) === JSON.stringify(BUILD_STOREFRONT) ? 'build' : '')).filter(Boolean);
    const build = seq.indexOf('build');
    assert.ok(build > 0 && seq.lastIndexOf('online', build) >= 0 && seq.indexOf('offline', build) > build, seq.join(' → '));
    assert.equal(done.internet ?? null, null, 'offline once ready');
    assert.match(done.steps.find(s => s.key === 'theme-compile')!.log.join('\n'), /Gebautes Storefront-JavaScript fehlt[\s\S]*Storefront gebaut und Theme kompiliert/);
  } finally { fake.script = () => undefined; await J.finishTask(id); }
});

test('internet only for a ready sandbox or a setup that waits for it', async () => {
  const t = T.getTask(fullTask)!;
  T.saveTask({ ...t, status: 'setting_up' }, false);
  try { await assert.rejects(I.grantInternet(t.id, { via: 'panel' }), (e: Error & { status?: number }) => e.status === 409); } finally { T.saveTask({ ...T.getTask(t.id)!, status: 'ready' }, false); }
  await J.finishTask(t.id);
});

test('installed completely: a failed composer install (missing credentials) fails the step with the hint and ends internet', async () => {
  fake.script = argv => (isComposerInstall(argv) ? { exitCode: 1, output: '  The "https://packages.shopware.com/packages.json" file could not be downloaded (HTTP/2 401 )\n' } : undefined);
  try {
    const id = start('acme/shop');
    await until(() => !!T.getTask(id)?.awaitingInternet, 20_000);
    await I.grantInternet(id, { via: 'panel' });
    await settled(id);
    const t = T.getTask(id)!;
    assert.equal(t.status, 'failed');
    assert.match(t.error!, /composer install fehlgeschlagen \(Exit-Code 1\)\. .*COMPOSER_AUTH/);
    assert.equal(t.internet ?? null, null);
    assert.ok(!fake.containers.get(t.containerId!)!.networks.includes('lotse-sandbox-egress'), 'detached again');
    await J.finishTask(id);
  } finally { fake.script = () => undefined; }
});

test('stopping the setup while it waits for internet ends the wait', async () => {
  const id = start('acme/shop');
  await until(() => !!T.getTask(id)?.awaitingInternet, 20_000);
  await J.stopSetup(id);
  const t = T.getTask(id)!;
  assert.equal(t.status, 'interrupted');
  assert.ok(!t.awaitingInternet);
  assert.equal(T.publicTask(t).awaitingInternet, undefined);
  await J.finishTask(id);
});

test('overlay: chosen in .lotse/sandbox.json, or the fallback when the environment forbids internet', async () => {
  const a = start('acme/overlay-shop');
  await settled(a);
  const ta = T.getTask(a)!;
  assert.equal(ta.status, 'ready', ta.error ?? '');
  assert.equal(ta.layout!.project!.install, 'overlay');
  assert.ok(!ops(ta.containerId!).some(c => c.op === 'connectEgress'), 'never online');
  await J.finishTask(a);

  E.saveSandbox({ enabled: true, internet: 'never' });
  try {
    const b = start('acme/shop');
    await settled(b);
    const tb = T.getTask(b)!;
    assert.equal(tb.status, 'ready', tb.error ?? '');
    assert.equal(tb.layout!.project!.install, 'overlay');
    assert.match(tb.steps.find(s => s.key === 'install-plugin')!.log.join('\n'), /Projekt vollständig installieren braucht Internet für composer install, das ist hier nicht möglich: Internet im Container ist in der Sandbox-Umgebung ausgeschaltet/);
    assert.ok(!files(tb.containerId!).has(`${ROOT}/composer.json`), 'overlay never syncs composer.json');
    await J.finishTask(b);
  } finally { E.saveSandbox({ enabled: true, internet: 'approval' }); }
});

test('a config file of the image for a bundle the project does not register is removed; the project\'s own files stay', async () => {
  const { removeImageLeftovers } = await import('../../src/server/sandbox/templates/dockware-project');
  const root = fs.mkdtempSync(path.join(tmp, 'leftover-'));
  fs.mkdirSync(path.join(root, 'config/packages'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config/packages/web_profiler.yaml'), 'web_profiler: {}\n'); // the project's own file of that name
  const ran: string[][] = [];
  const ctx = {
    projectRoot: () => root,
    run: async (argv: string[]) => { ran.push(argv); return { exitCode: 0, output: argv[0] === 'grep' ? 'config/packages/dev/web_profiler.yaml\nconfig/packages/web_profiler.yaml\nconfig/packages/../../etc/passwd\n' : '' }; },
  } as unknown as Parameters<typeof removeImageLeftovers>[0];
  const out = 'In ContainerBuilder.php line 1:\n  Container extension "web_profiler" is not registered.';
  assert.deepEqual(await removeImageLeftovers(ctx, out), ['config/packages/dev/web_profiler.yaml']);
  assert.deepEqual(ran.filter(a => a[0] === 'rm'), [['rm', '-f', '--', 'config/packages/dev/web_profiler.yaml']]);
  assert.deepEqual(await removeImageLeftovers(ctx, 'something else'), []);
});

test('installed completely: plugins composer.json requires (vendor/) are installed too, a failure there is only a warning; not in overlay', async () => {
  const { installExtensions } = await import('../../src/server/sandbox/templates/dockware-project');
  fs.writeFileSync(path.join(tmp, 'composer.json'), JSON.stringify({ require: { 'shopware/core': '6.7.15.1', 'frosh/tools': '^3.0', 'acme/licensed': '*', 'acme/own': '*' } }));
  const make = () => {
    const log: string[] = [], ran: string[][] = [];
    const ctx = {
      hasDump: () => false, log: (l: string) => { log.push(l); }, setLayout: () => {}, projectRoot: () => tmp,
      run: async (argv: string[]) => {
        ran.push(argv);
        const joined = argv.join(' ');
        if (joined.includes("path LIKE 'vendor/%'")) return { exitCode: 0, output: 'FroshTools\tfrosh/tools\nLicensed\tacme/licensed\nIndirect\tacme/indirect\nOwn\tacme/own\n' };
        if (joined.includes('CONCAT(installed_at')) return { exitCode: 0, output: 'Own 11\nFroshTools 11\n' };
        if (argv[1] === 'plugin:install' && argv.includes('Licensed')) return { exitCode: 1, output: 'In PluginLifecycleService.php line 9:\n  License missing\n' };
        return { exitCode: argv[1] === 'debug:config' ? 1 : 0, output: '' };
      },
    } as unknown as Parameters<typeof installExtensions>[0];
    return { ctx, log, ran };
  };
  const installs = (ran: string[][]) => ran.filter(r => r[1] === 'plugin:install').map(r => r.slice(r.indexOf('--') + 1));
  for (const mode of ['full', 'overlay'] as const) {
    const p = { install: mode, plugins: [{ name: 'Own', composerName: 'acme/own' }], apps: [] } as unknown as Parameters<typeof installExtensions>[2];
    const a = make();
    await installExtensions(a.ctx, { kind: 'project', project: p } as unknown as Parameters<typeof installExtensions>[1], p, new Set(), null);
    if (mode === 'overlay') { assert.deepEqual(installs(a.ran), [['Own']]); continue; }
    assert.deepEqual(installs(a.ran), [['FroshTools'], ['Licensed'], ['Own']], 'only direct requirements, the project\'s own plugin once');
    assert.ok(a.log.some(x => /Warnung: Plugin Licensed \(über composer eingebunden\).*License missing/.test(x)), a.log.join('\n'));
    assert.ok(a.log.includes('Plugins installiert und aktiv: Own, FroshTools'), a.log.join('\n'));
  }
  fs.rmSync(path.join(tmp, 'composer.json'));
});

test('with a database dump a plugin the repository has in a newer version is updated (its migrations), a failed update is a warning', async () => {
  const { installExtensions } = await import('../../src/server/sandbox/templates/dockware-project');
  const log: string[] = [], ran: string[][] = [];
  const ctx = {
    hasDump: () => true, log: (l: string) => { log.push(l); }, setLayout: () => {}, projectRoot: () => tmp,
    run: async (argv: string[]) => {
      ran.push(argv);
      const joined = argv.join(' ');
      if (joined.includes('FROM plugin WHERE installed_at IS NOT NULL AND upgrade_version')) return { exitCode: 0, output: 'Loyalty\t1.2.0\t1.3.0\nBroken\t1.0.0\t2.0.0\n' };
      if (joined.includes('FROM plugin WHERE installed_at')) return { exitCode: 0, output: 'Loyalty\t1\tcustom/plugins/Loyalty\nBroken\t1\tcustom/plugins/Broken\nSame\t0\tcustom/plugins/Same\n' };
      if (argv[1] === 'plugin:update') return argv.includes('Broken') ? { exitCode: 1, output: 'In MigrationStep.php line 12:\n  Table "acme_x" already exists\n' } : { exitCode: 0, output: '' };
      return { exitCode: argv[1] === 'debug:config' ? 1 : 0, output: '' };
    },
  } as unknown as Parameters<typeof installExtensions>[0];
  const p = { plugins: [{ name: 'Loyalty' }, { name: 'Broken' }, { name: 'Same' }], apps: [] } as unknown as Parameters<typeof installExtensions>[2];
  await installExtensions(ctx, { kind: 'project', project: p } as unknown as Parameters<typeof installExtensions>[1], p, new Set(), null);
  const updates = ran.filter(r => r[1] === 'plugin:update').map(r => r.slice(r.indexOf('--') + 1));
  assert.deepEqual(updates, [['Loyalty', 'Broken'], ['Loyalty'], ['Broken']]);
  assert.ok(ran.findIndex(r => r[1] === 'plugin:refresh') < ran.findIndex(r => r[1] === 'plugin:update'), 'refresh records the upgrade first');
  assert.ok(log.includes('Plugins auf die Version des Repositorys aktualisiert (plugin:update, mit Migrationen): Loyalty 1.2.0 → 1.3.0'), log.join('\n'));
  assert.ok(log.some(x => /Warnung: Plugin Broken .*aktualisieren.*acme_x/.test(x)), log.join('\n'));
  assert.equal(ran.filter(r => r[1] === 'plugin:install').length, 0, 'the dump knows them all: nothing installed');
});

test('with a database dump nothing is installed or activated (plugins it lacks stay off); without one the setup fails', async () => {
  const { installExtensions } = await import('../../src/server/sandbox/templates/dockware-project');
  const make = (dump: boolean, rows = 'Other\t1\tcustom/plugins/Other\n') => {
    const log: string[] = [], ran: string[][] = [];
    const ctx = {
      hasDump: () => dump, log: (l: string) => { log.push(l); }, setLayout: () => {}, projectRoot: () => tmp,
      run: async (argv: string[]) => {
        ran.push(argv);
        const joined = argv.join(' ');
        if (joined.includes('FROM plugin WHERE installed_at')) return { exitCode: 0, output: rows };
        if (joined.includes('CONCAT(installed_at')) return { exitCode: 0, output: 'Good 11\n' };
        if (argv[1] === 'plugin:install') {
          const names = argv.slice(argv.indexOf('--') + 1);
          return names.includes('Bad') ? { exitCode: 1, output: 'In RequirementsValidator.php line 70:\n  Required plugin/package "acme/base" is missing\n' } : { exitCode: 0, output: '' };
        }
        return { exitCode: argv[1] === 'debug:config' ? 1 : 0, output: '' };
      },
    } as unknown as Parameters<typeof installExtensions>[0];
    return { ctx, log, ran };
  };
  const p = { plugins: [{ name: 'Good' }, { name: 'Bad' }, { name: 'Other' }], apps: [] } as unknown as Parameters<typeof installExtensions>[2];
  const l = { kind: 'project', project: p } as unknown as Parameters<typeof installExtensions>[1];
  const a = make(true);
  await installExtensions(a.ctx, l, p, new Set(), null);
  assert.equal(a.ran.filter(r => r[1] === 'plugin:install').length, 0, 'the dump decides');
  assert.ok(a.log.some(x => /Plugins bleiben, wie sie im Dump sind \(1 der Projekt-Plugins darin installiert\)/.test(x)), a.log.join('\n'));
  assert.ok(a.log.some(x => x.startsWith('Nicht im Dump installiert und deshalb aus: Good, Bad.')), a.log.join('\n'));
  // no dump registered with the sandbox, but the database already has a project plugin installed: its state counts, nothing is installed over it
  const c = make(false, 'Good\t1\tcustom/plugins/Good\nBad\t1\tcustom/plugins/Bad\nOther\t1\tcustom/plugins/Other\n');
  await installExtensions(c.ctx, l, p, new Set(), null);
  assert.ok(c.log.some(x => /Datenbank kennt die Projekt-Plugins schon/.test(x)));
  assert.equal(c.ran.filter(r => r[1] === 'plugin:install').length, 0);
  // a pristine database (no row of a project plugin): they are installed, and a failure fails the step
  const b = make(false, '');
  await assert.rejects(installExtensions(b.ctx, l, p, new Set(), null), /Nicht installiert und aktiviert: Bad/);
});

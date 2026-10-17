import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../isolate-data';

// Workspace → container: only allowed paths, owner www-data (33), long paths via PAX; .git, secrets, node_modules and
// symlinks to the outside never; deletions only as ['rm', '-f', '--', <target>/<guarded path>].
const { syncAll, syncPaths, guardRel, isSecretPath } = await import('../../src/server/sandbox/sync');
const { writeTar } = await import('../../src/server/sandbox/tar');
const { FakeRunner, readTarEntries } = await import('../../src/server/sandbox/fake-runner');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-sync-'));
const wt = path.join(root, 'repo');
const put = (f: string, c = 'x') => { fs.mkdirSync(path.dirname(path.join(wt, f)), { recursive: true }); fs.writeFileSync(path.join(wt, f), c); };
put('composer.json', '{}'); put('src/Resources/views/base.html.twig', '{% block x %}{% endblock %}');
put('.git', 'gitdir: /data/git/t_x'); put('sub/.git/config', '[core]');
put('.env', 'APP_SECRET=1'); put('.env.local', 'X=1'); put('.env.dist', 'X='); put('config/auth.json', '{}'); put('certs/server.key', 'k');
put('node_modules/pkg/index.js', 'evil()');
const deep = `${'verzeichnis/'.repeat(12)}datei-mit-einem-langen-namen.scss`; put(deep, '.a{}');
fs.symlinkSync('/etc/passwd', path.join(wt, 'outside'));
fs.symlinkSync('composer.json', path.join(wt, 'inside'));
fs.symlinkSync(path.join(wt, 'composer.json'), path.join(wt, 'absolute-inside'));
fs.chmodSync(path.join(wt, 'composer.json'), 0o755);

const fake = new FakeRunner();
fake.images.add('dockware/shopware:6.7.15.1');
after(async () => { await fake.close(); fs.rmSync(root, { recursive: true, force: true }); });
const TARGET = '/var/www/html/custom/plugins/AcmeTheme';
const cid = await fake.create({ name: 'lotse-sbx-t-sync00000000', Image: 'dockware/shopware:6.7.15.1', Labels: { 'lotse.managed': '1', 'lotse.task': 't_sync00000000' } });
await fake.start(cid);
const target = { runner: fake, containerId: cid, worktree: wt, target: TARGET, user: 'www-data' };

test('syncAll: clean mirror with only allowed entries, owned by www-data', async () => {
  const r = await syncAll(target);
  const rm = fake.calls.filter(c => c.op === 'exec').map(c => c.argv);
  assert.deepEqual(rm, [['rm', '-rf', '--', TARGET]], 'the plugin directory is replaced');
  const { dir, entries } = fake.archives.at(-1)!;
  assert.equal(dir, '/var/www/html/custom/plugins');
  const paths = entries.map(e => e.path);
  for (const p of ['AcmeTheme', 'AcmeTheme/composer.json', 'AcmeTheme/src/Resources/views/base.html.twig', 'AcmeTheme/.env.dist', `AcmeTheme/${deep}`]) assert.ok(paths.includes(p), p);
  for (const p of ['.git', 'sub/.git/config', '.env', '.env.local', 'config/auth.json', 'certs/server.key', 'node_modules/pkg/index.js', 'outside', 'absolute-inside']) assert.ok(!paths.includes(`AcmeTheme/${p}`), p);
  assert.ok(entries.every(e => e.uid === 33 && e.gid === 33));
  const link = entries.find(e => e.path === 'AcmeTheme/inside')!;
  assert.equal(link.type, 'symlink'); assert.equal(link.linkTarget, 'composer.json');
  assert.equal(entries.find(e => e.path === 'AcmeTheme/composer.json')!.mode, 0o755);
  assert.equal(fake.containers.get(cid)!.files.get(`${TARGET}/${deep}`)?.toString(), '.a{}', 'long path via PAX');
  assert.equal(r.files, entries.filter(e => e.type === 'file').length);
});

test('syncPaths: changed files uploaded with parents, deleted ones removed with the fixed argv', async () => {
  fake.calls = [];
  put('src/Resources/views/new.html.twig', 'neu');
  fs.rmSync(path.join(wt, 'src/Resources/views/base.html.twig'));
  const r = await syncPaths(target, ['src/Resources/views/new.html.twig', './src/Resources/views/base.html.twig']);
  assert.deepEqual(r, { put: 1, removed: 1 });
  assert.deepEqual(fake.calls.filter(c => c.op === 'exec').map(c => c.argv), [['rm', '-f', '--', `${TARGET}/src/Resources/views/base.html.twig`]]);
  assert.deepEqual(readTarEntries(writeTar([{ path: 'a', type: 'dir' }], { uid: 33, gid: 33, uname: 'www-data', gname: 'www-data' })).map(e => e.path), ['a']);
  assert.deepEqual(fake.archives.at(-1)!.entries.map(e => e.path), ['AcmeTheme', 'AcmeTheme/src', 'AcmeTheme/src/Resources', 'AcmeTheme/src/Resources/views', 'AcmeTheme/src/Resources/views/new.html.twig']);
  for (const bad of ['../etc/passwd', '/etc/passwd', 'a/../../x', '.git/config', 'x/.env', 'node_modules/a.js', '', 'a\\b', 'a\0b']) await assert.rejects(syncPaths(target, [bad]), /Pfad|übertragen/, bad);
  await assert.rejects(syncAll({ ...target, target: '/var/www/html/custom/plugins/../../../etc' }), /Zielverzeichnis/);
  await assert.rejects(syncAll({ ...target, target: '/' }), /Zielverzeichnis/);
});

test('guards: secret paths and normalisation', () => {
  assert.equal(guardRel('src//a/./b.twig'), 'src/a/b.twig');
  for (const p of ['.env', 'a/.env.production', 'id_rsa', 'x/deploy.pem', 'auth.json', '.npmrc']) assert.ok(isSecretPath(p), p);
  for (const p of ['.env.dist', '.env.example', 'environment.ts', 'src/key.php', 'README.md']) assert.ok(!isSecretPath(p), p);
});

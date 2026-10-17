import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../isolate-data';

// File access of the coding agent: confined to the worktree by realpath, secrets and .git denied, limits.
const W = await import('../../src/server/sandbox/workspace-fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-wsfs-'));
const root = path.join(tmp, 'repo'), dataDir = path.join(tmp, 'data');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const put = (rel: string, text: string | Buffer) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
put('src/Resources/views/storefront/layout/header/header.html.twig', "{% sw_extends '@Storefront/storefront/layout/header/header.html.twig' %}\n");
put('src/Resources/app/storefront/src/scss/base.scss', '.a { color: red; }\n.b { color: red; }\n');
put('.git', 'gitdir: /data/git/t_x\n'); // the worktree's gitfile
put('.env', 'APP_SECRET=x\n');
put('auth.json', '{}');
put('keys/deploy.pem', 'k');
put('config/jwt/private.pem', 'k');
put('vendor/acme/lib.php', '<?php');
put('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]));
put('big.txt', 'x'.repeat(W.FS_LIMITS.read + 1));
fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(path.join(dataDir, 'secret.key'), 's');
fs.symlinkSync('/etc', path.join(root, 'etc-link'));
fs.symlinkSync(dataDir, path.join(root, 'data-link'));
fs.symlinkSync('.env', path.join(root, 'env-link'));
fs.symlinkSync('/etc/passwd', path.join(root, 'passwd'));
fs.symlinkSync('README.md', path.join(root, 'readme-link'));
put('README.md', '# Acme\n');

const denied = (rel: string, o: { forWrite?: boolean } = {}, re: RegExp = /gesperrt|außerhalb|Ungültig/) => assert.throws(() => W.resolveInWorkspace(root, rel, o), re, rel);

test('relative paths inside the worktree resolve; ../, absolute and NUL paths are refused', () => {
  const r = W.resolveInWorkspace(root, './src//Resources/../Resources/views/');
  assert.equal(r.rel, 'src/Resources/views');
  assert.equal(r.real, path.join(fs.realpathSync(root), 'src/Resources/views'));
  for (const p of ['../x', 'src/../../x', '/etc/passwd', 'C:/x', 'a\\b', 'a\0b']) denied(p);
});

test('symlinks to /etc, to the data dir or to a secret are refused; a link inside the worktree is read through', () => {
  for (const p of ['etc-link', 'etc-link/passwd', 'data-link/secret.key', 'passwd', 'env-link']) denied(p);
  denied('etc-link/new.txt', { forWrite: true }); // new file below a symlinked parent
  denied('data-link/x.twig', { forWrite: true });
  assert.equal(W.readText(root, 'readme-link').text, '1│# Acme\n2│');
  denied('readme-link', { forWrite: true }, /Symlink/); // never written through
});

test('.git (gitfile), .env, auth.json, keys and config/jwt are denied; vendor is read-only', () => {
  for (const p of ['.git', '.git/config', '.env', '.env.local', 'auth.json', 'keys/deploy.pem', 'config/jwt/private.pem', 'sub/.GIT/x']) denied(p);
  assert.ok(W.readText(root, 'vendor/acme/lib.php').text.includes('<?php'));
  assert.throws(() => W.writeText(root, 'vendor/acme/lib.php', 'x'), /schreibgeschützt/);
  assert.throws(() => W.writeText(root, 'node_modules/x/index.js', 'x'), /schreibgeschützt/);
});

test('binary files and size limits', () => {
  assert.throws(() => W.readText(root, 'logo.png'), /Binärdatei/);
  assert.throws(() => W.readText(root, 'big.txt'), /zu groß/);
  assert.throws(() => W.writeText(root, 'huge.txt', 'x'.repeat(W.FS_LIMITS.write + 1)), /zu groß/);
  assert.throws(() => W.writeText(root, 'nul.txt', 'a\0b'), /NUL/);
});

test('listing hides denied entries and does not descend into vendor or symlinks', () => {
  const { entries, truncated } = W.listFiles(root, '', 6);
  const paths = entries.map(e => e.path);
  assert.equal(truncated, false);
  for (const p of ['.git', '.env', 'auth.json', 'keys/deploy.pem', 'config/jwt/']) assert.ok(!paths.includes(p), p);
  assert.ok(paths.includes('src/Resources/views/storefront/layout/header/'), 'six levels deep');
  assert.ok(W.listFiles(root, 'src/Resources/views', 4).entries.some(e => e.path === 'src/Resources/views/storefront/layout/header/header.html.twig'));
  assert.ok(paths.includes('vendor/') && !paths.includes('vendor/acme/'));
  assert.deepEqual(entries.find(e => e.path === 'etc-link'), { path: 'etc-link', type: 'link' });
  assert.ok(W.listFiles(root, 'vendor').entries.some(e => e.path === 'vendor/acme/lib.php'), 'vendor on request');
});

test('edit_file needs a unique match unless replace_all; write/delete report changed lines', () => {
  const scss = 'src/Resources/app/storefront/src/scss/base.scss';
  assert.throws(() => W.editText(root, scss, 'color: red', 'color: green'), /2-mal/);
  assert.throws(() => W.editText(root, scss, 'color: blue', 'x'), /nicht vor/);
  const one = W.editText(root, scss, '.a { color: red; }', '.a { color: green; }');
  assert.deepEqual({ kind: one.kind, added: one.added, removed: one.removed, replaced: one.replaced }, { kind: 'edit', added: 1, removed: 1, replaced: 1 });
  const all = W.editText(root, scss, 'color', 'background-color', true);
  assert.equal(all.replaced, 2);
  assert.equal(fs.readFileSync(path.join(root, scss), 'utf8'), '.a { background-color: green; }\n.b { background-color: red; }\n');
  const created = W.writeText(root, 'src/Resources/views/storefront/layout/footer/footer.html.twig', 'a\nb\n');
  assert.deepEqual(created, { path: 'src/Resources/views/storefront/layout/footer/footer.html.twig', kind: 'create', added: 2, removed: 0 });
  const gone = W.deleteText(root, 'src/Resources/views/storefront/layout/footer/footer.html.twig');
  assert.equal(gone.kind, 'delete');
  assert.throws(() => W.deleteText(root, 'src'), /keine Datei/);
});

test('search: regex hits with path and line, no denied or binary files, capped', () => {
  const r = W.searchFiles(root, 'sw_extends');
  assert.deepEqual(r.hits, ["src/Resources/views/storefront/layout/header/header.html.twig:1: {% sw_extends '@Storefront/storefront/layout/header/header.html.twig' %}"]);
  assert.deepEqual(W.searchFiles(root, 'APP_SECRET').hits, [], '.env is never searched');
  assert.deepEqual(W.searchFiles(root, 'PNG').hits, []);
  assert.equal(W.searchFiles(root, 'color', { glob: '*.scss' }).hits.length, 2);
  assert.equal(W.searchFiles(root, 'color', { glob: '*.twig' }).hits.length, 0);
  assert.throws(() => W.searchFiles(root, '('), /regulärer Ausdruck/);
  let t = 0;
  assert.equal(W.searchFiles(root, 'x', { now: () => (t += 10_000) }).truncated, true, 'time cap');
});

test('search: a catastrophic pattern is interrupted within the time cap (no blocked event loop)', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'redos-'));
  fs.writeFileSync(path.join(dir, 'evil.txt'), `${'a'.repeat(60)}!\nok\n`);
  const t0 = Date.now(), r = W.searchFiles(dir, '(a+)+$');
  assert.ok(Date.now() - t0 < W.FS_LIMITS.searchMs + 1500, `took ${Date.now() - t0} ms`);
  assert.deepEqual(r, { hits: [], truncated: true, files: 1 });
  assert.deepEqual(W.searchFiles(dir, '^ok$').hits, ['evil.txt:2: ok']);
});

test('glob patterns', () => {
  assert.ok(W.globRe('*.twig').test('a/b/c.twig'));
  assert.ok(W.globRe('src/**/*.scss').test('src/Resources/app/x.scss'));
  assert.ok(W.globRe('src/**').test('src/a/b.txt'));
  assert.ok(!W.globRe('src/*.scss').test('src/a/b.scss'));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import '../isolate-data';

// Guard of Claude Code's own file tools in a sandbox chat: paths realpath-confined to the worktree, no .git/secrets, writes not into
// vendor/node_modules, Grep never reads secret files, card counts after a write.
const { SECRET_EXCLUDE, guardNative, nativeChange, relOf, textBefore } = await import('../../src/server/sandbox/native-tools');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-native-'));
const put = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
put('src/a.twig', 'a\n'); put('vendor/lib.php', '<?php'); put('README.md', '# x\n');
fs.writeFileSync(path.join(root, '.git'), 'gitdir: /elsewhere\n');
fs.symlinkSync('/etc', path.join(root, 'etc-link'));

test('relOf: relative stays, absolute inside becomes relative, outside throws', () => {
  assert.equal(relOf(root, 'src/a.twig'), 'src/a.twig');
  assert.equal(relOf(root, path.join(root, 'src/a.twig')), 'src/a.twig');
  assert.equal(relOf(root, root), '');
  assert.throws(() => relOf(root, '/etc/passwd'), /außerhalb/);
  assert.throws(() => relOf(root, `${root}-other/x`), /außerhalb/);
  assert.throws(() => relOf(root, ''), /fehlt/);
  // Claude Code expands ~ in Glob/Grep `path` to the home directory of the Lotse process
  for (const p of ['~', '~/', '~/.codex', '~root/.ssh']) assert.throws(() => relOf(root, p), /~/, p);
});

test('guardNative: allowed and refused calls', () => {
  const ok = (tool: string, input: Record<string, unknown>) => assert.equal(guardNative(root, tool, input).ok, true, `${tool} ${JSON.stringify(input)}`);
  const no = (tool: string, input: Record<string, unknown>) => assert.equal(guardNative(root, tool, input).ok, false, `${tool} ${JSON.stringify(input)}`);
  ok('Read', { file_path: path.join(root, 'vendor/lib.php') });
  ok('Write', { file_path: path.join(root, 'src/new/b.twig'), content: '' });
  ok('Glob', { pattern: 'src/**/*.twig' });
  ok('Glob', { pattern: `${root}/src/*.twig` });
  ok('TodoWrite', { todos: [] });
  no('Write', { file_path: path.join(root, 'vendor/lib.php') });
  no('Read', { file_path: path.join(root, '.git') });
  no('Read', { file_path: path.join(root, 'etc-link/passwd') });
  no('Read', { file_path: path.join(root, '../x') });
  no('Glob', { pattern: '/etc/*' });
  no('Glob', { pattern: '**/*', path: '~' });
  no('Glob', { pattern: '~/.codex/*' });
  fs.mkdirSync(path.join(root, '~/.codex'), { recursive: true }); // a folder literally named ~ in the worktree changes nothing
  no('Grep', { pattern: '.', path: '~/.codex', output_mode: 'content' });
  no('Grep', { pattern: '.', path: '~' });
  no('Bash', { command: 'ls' });
  no('MultiTool', {});
});

// How Claude Code (2.1.296) turns Grep's `glob` into ripgrep arguments: split at whitespace, outside braces also at commas.
const ccGlobs = (glob: string) => glob.split(/\s+/).flatMap(g => (g.includes('{') && g.includes('}') ? [g] : g.split(',').filter(Boolean)));
const rg = spawnSync('rg', ['--version']).status === 0;

test('Grep: the secret exclusion is always appended last, also after a glob of the AI', () => {
  const plain = guardNative(root, 'Grep', { pattern: 'x' });
  assert.ok(plain.ok && plain.input.glob === SECRET_EXCLUDE);
  const g = guardNative(root, 'Grep', { pattern: 'x', glob: '*.twig' });
  assert.ok(g.ok && g.input.glob === `*.twig ${SECRET_EXCLUDE}`);
  assert.equal(ccGlobs(String(g.ok && g.input.glob)).at(-1), SECRET_EXCLUDE, 'stays one --glob argument, the last one');
  assert.ok(guardNative(root, 'Grep', { pattern: 'x', path: path.join(root, 'src') }).ok, 'a folder');
  assert.equal(guardNative(root, 'Grep', { pattern: 'x', path: path.join(root, '.env.local') }).ok, false);
  assert.equal(guardNative(root, 'Grep', { pattern: 'x', glob: '../*' }).ok, false);
  assert.equal(guardNative(root, 'Grep', { pattern: 'x', glob: '*.php,/etc/*' }).ok, false);
});

test('Grep with ripgrep: no glob reaches secret files', { skip: !rg && 'rg not installed' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-rg-'));
  const w = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  w('.env', 'TOKEN'); w('sub/.ENV.local', 'TOKEN'); w('auth.json', 'TOKEN'); w('config/jwt/private.pem', 'TOKEN'); w('vendor/x/id_rsa', 'TOKEN'); w('a.php', 'TOKEN');
  for (const glob of [undefined, '*.php,.env', '*.php .env', '{.env,x}', '[.]env', '*', '**/*.pem', '!*.php', 'auth.json', '.ENV*']) {
    const v = guardNative(dir, 'Grep', { pattern: 'TOKEN', output_mode: 'files_with_matches', ...(glob === undefined ? {} : { glob }) });
    assert.ok(v.ok, String(glob));
    const args = ['--hidden', '-l', ...ccGlobs(String(v.input.glob)).flatMap(g => ['--glob', g]), 'TOKEN', '.'];
    const out = spawnSync('rg', args, { cwd: dir, encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean).map(f => f.replace(/^\.\//, ''));
    assert.ok(out.every(f => f === 'a.php'), `${glob}: ${out.join(', ')}`);
    if (glob === undefined || glob === '*' || glob === '*.php .env') assert.deepEqual(out, ['a.php'], 'ripgrep did search');
  }
});

test('card counts: textBefore + nativeChange', () => {
  const file = path.join(root, 'src/a.twig');
  const before = textBefore(root, file);
  fs.writeFileSync(file, 'a\nb\n');
  assert.deepEqual(nativeChange(root, file, before), { path: 'src/a.twig', kind: 'edit', added: 1, removed: 0 });
  assert.deepEqual(nativeChange(root, path.join(root, 'src/new.twig'), null), null, 'nothing written');
  put('src/new.twig', 'x\n');
  assert.deepEqual(nativeChange(root, path.join(root, 'src/new.twig'), null), { path: 'src/new.twig', kind: 'create', added: 1, removed: 0 });
  assert.equal(nativeChange(root, path.join(root, '.env.local'), null), null);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../isolate-data';

// Guard of Claude Code's own file tools in a sandbox chat: paths realpath-confined to the worktree, no .git/secrets, writes not into
// vendor/node_modules, Grep never reads secret files, card counts after a write.
const { guardNative, nativeChange, relOf, secretFiles, textBefore } = await import('../../src/server/sandbox/native-tools');

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
  no('Bash', { command: 'ls' });
  no('MultiTool', {});
});

test('Grep: unchanged without secret files; with them excluded by glob, and a glob that would include them is refused', () => {
  const plain = guardNative(root, 'Grep', { pattern: 'x' });
  assert.ok(plain.ok && plain.input.glob === undefined);
  put('.env.local', 'SECRET=1'); put('certs/server.key', 'k'); put('.env.example', 'SAFE=1');
  assert.deepEqual(secretFiles(root).sort(), ['.env.local', 'certs/server.key']);
  const g = guardNative(root, 'Grep', { pattern: 'SECRET' });
  assert.ok(g.ok);
  assert.equal(g.ok && g.input.glob, '!{.env.local,server.key}');
  assert.ok(guardNative(root, 'Grep', { pattern: 'x', glob: '*.twig' }).ok);
  assert.equal(guardNative(root, 'Grep', { pattern: 'x', glob: '*.key' }).ok, false);
  assert.equal(guardNative(root, 'Grep', { pattern: 'x', glob: '!*.twig' }).ok, false);
  assert.ok(guardNative(root, 'Grep', { pattern: 'x', path: path.join(root, 'src') }).ok, 'a folder without secrets');
  assert.equal(guardNative(root, 'Grep', { pattern: 'x', path: path.join(root, '.env.local') }).ok, false);
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

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Hardened git executor against a local bare repository (file:// remote, explicitly allowed for tests only):
// separate git dir, no hooks/fsmonitor, push only to lotse/*, the token never in config, URLs or error texts.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-git-'));
process.env.AICB_DATA = path.join(tmp, 'data');
const REMOTE = path.join(tmp, 'remote'), BARE = path.join(REMOTE, 'acme', 'plugin.git');
process.env.LOTSE_GITHUB_CLONE_BASE = `file://${REMOTE}`;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Remote fixture with plain git (outside the executor)
const sys = (args: string[], cwd = tmp) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' } }).trim();
fs.mkdirSync(BARE, { recursive: true });
sys(['init', '--bare', '-q', BARE]);
const seed = path.join(tmp, 'seed');
sys(['init', '-q', seed]);
fs.writeFileSync(path.join(seed, 'composer.json'), '{"name":"acme/plugin"}\n');
sys(['add', '-A'], seed); sys(['commit', '-q', '-m', 'init'], seed); sys(['push', '-q', BARE, 'HEAD:refs/heads/main'], seed);
const remoteSha = (ref: string) => { try { return sys(['--git-dir', BARE, 'rev-parse', '--verify', '-q', ref]); } catch { return null; } };

const TOKEN = `github_pat_${'Z9y8X7w6V5'.repeat(8)}_abc`;
const BASIC = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
const { saveGithub } = await import('../../src/server/github');
const G = await import('../../src/server/git');
saveGithub({ token: TOKEN });

const WT = path.join(tmp, 'work', 't1'), GD = path.join(tmp, 'gitdirs', 't1');
const ME = { name: 'Lotse', email: 'lotse@example.com' };
const noLeak = (s: string) => { assert.ok(!s.includes(TOKEN), 'token leaked'); assert.ok(!s.includes(BASIC), 'credential leaked'); };

test('file:// remotes are refused unless explicitly allowed for tests', async () => {
  G.allowFileRemotesForTests(false);
  await assert.rejects(G.cloneRepo('acme/plugin', 'main', path.join(tmp, 'work', 'blocked'), path.join(tmp, 'gitdirs', 'blocked')), (e: Error) => { noLeak(e.message); return /git clone/.test(e.message); });
  G.allowFileRemotesForTests(true);
});

test('clone: shallow single branch, gitfile points to a git dir outside the worktree', async () => {
  const { head } = await G.cloneRepo('acme/plugin', 'main', WT, GD);
  assert.equal(head, remoteSha('refs/heads/main'));
  const gitfile = fs.readFileSync(path.join(WT, '.git'), 'utf8').trim();
  assert.equal(gitfile, `gitdir: ${GD}`);
  assert.ok(!path.relative(WT, GD).match(/^[^.]/), 'git dir is not inside the worktree');
  assert.ok(fs.existsSync(path.join(WT, 'composer.json')));
  noLeak(fs.readFileSync(path.join(GD, 'config'), 'utf8'));
  const url = (await G.runGit(['remote', 'get-url', 'origin'], { cwd: WT, gitDir: GD })).stdout.trim();
  assert.equal(url, `file://${REMOTE}/acme/plugin.git`);
  noLeak(url);
  await assert.rejects(G.cloneRepo('acme/plugin', 'main', WT, path.join(tmp, 'gitdirs', 'other')), /nicht leer/);
  await assert.rejects(G.cloneRepo('acme/plugin', 'main', path.join(tmp, 'work', 'x'), path.join(tmp, 'work', 'x', 'g')), /getrennt/);
});

test('validation: repository and branch names never reach argv unchecked', async () => {
  for (const b of ['-x', '--upload-pack=touch', 'a..b', 'a b', 'main@{1}', 'x:y', '']) await assert.rejects(G.assertBaseBranch(b), /Branch-Name/, b);
  assert.equal(await G.assertBaseBranch('feature/new-header'), 'feature/new-header');
  for (const r of ['acme', '../x/y', 'acme/plugin;rm', '-acme/x y']) await assert.rejects(G.cloneRepo(r, 'main', path.join(tmp, 'work', 'v'), path.join(tmp, 'gitdirs', 'v')), /Repository-Name/, r);
  for (const b of ['main', 'lotse/../x', '-f', 'refs/heads/main', 'lotse/AB', 'lotse/x', 'lotse/-abc', 'feature/x']) assert.throws(() => G.assertLotseBranch(b), /lotse\//, b);
  assert.equal(G.assertLotseBranch('lotse/neuer-header-4f2a'), 'lotse/neuer-header-4f2a');
  for (const branch of ['main', 'lotse/../x', '-f']) await assert.rejects(G.pushBranch({ repo: 'acme/plugin', branch, worktree: WT, gitDir: GD }), /lotse\//, branch);
  assert.equal(remoteSha('refs/heads/main'), sys(['--git-dir', BARE, 'rev-parse', 'refs/heads/main']));
});

test('hooks and fsmonitor planted in the git dir do not run', async () => {
  const marker = path.join(tmp, 'pwned');
  const script = path.join(tmp, 'evil.sh');
  fs.writeFileSync(script, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(GD, 'hooks'), { recursive: true });
  for (const h of ['pre-commit', 'commit-msg', 'post-commit', 'pre-push', 'post-index-change']) fs.copyFileSync(script, path.join(GD, 'hooks', h));
  sys(['--git-dir', GD, 'config', 'core.fsmonitor', script]);
  sys(['--git-dir', GD, 'config', 'core.hooksPath', path.join(GD, 'hooks')]);
  fs.writeFileSync(path.join(WT, 'Resources.txt'), 'neu\n');
  const sha = await G.commitAll(WT, GD, 'Kopfzeile angepasst', ME);
  assert.match(sha ?? '', /^[0-9a-f]{40}$/);
  assert.ok(!fs.existsSync(marker), 'no hook or fsmonitor ran');
});

test('commit and push land as lotse/<slug> in the bare repo; main stays untouched', async () => {
  const mainBefore = remoteSha('refs/heads/main');
  fs.writeFileSync(path.join(WT, 'README.md'), '# Plugin\n');
  const sha = await G.commitAll(WT, GD, 'README ergänzt', ME, { name: 'Alex', email: 'alex@example.com' });
  assert.ok(sha);
  assert.equal(await G.commitAll(WT, GD, 'leer', ME), null, 'nothing to commit');
  const msg = (await G.runGit(['log', '-1', '--format=%an <%ae>%n%B'], { cwd: WT, gitDir: GD })).stdout;
  assert.match(msg, /^Lotse <lotse@example\.com>/);
  assert.match(msg, /Co-Authored-By: Alex <alex@example\.com>/);
  const pushed = await G.pushBranch({ repo: 'acme/plugin', branch: 'lotse/readme-1a2b', worktree: WT, gitDir: GD });
  assert.equal(pushed.sha, sha);
  assert.equal(remoteSha('refs/heads/lotse/readme-1a2b'), sha);
  assert.equal(remoteSha('refs/heads/main'), mainBefore);

  // rewritten history: refused without a lease, accepted with the lease on exactly the pushed state, refused with a stale lease
  await G.runGit(['commit', '--amend', '-q', '--no-verify', '-m', 'README ergänzt (2)'], { cwd: WT, gitDir: GD, identity: ME });
  await assert.rejects(G.pushBranch({ repo: 'acme/plugin', branch: 'lotse/readme-1a2b', worktree: WT, gitDir: GD }), (e: Error) => { noLeak(e.message); return /git push/.test(e.message); });
  await assert.rejects(G.pushBranch({ repo: 'acme/plugin', branch: 'lotse/readme-1a2b', worktree: WT, gitDir: GD, pushedSha: '1'.repeat(40) }), /git push/);
  const again = await G.pushBranch({ repo: 'acme/plugin', branch: 'lotse/readme-1a2b', worktree: WT, gitDir: GD, pushedSha: sha });
  assert.equal(remoteSha('refs/heads/lotse/readme-1a2b'), again.sha);
  await assert.rejects(G.pushBranch({ repo: 'acme/plugin', branch: 'lotse/readme-1a2b', worktree: WT, gitDir: GD, pushedSha: 'nicht-sha' }), /Commit/);
});

test('the gitfile in the worktree is ignored: the executor always uses its own git dir', async () => {
  const other = path.join(tmp, 'elsewhere');
  sys(['init', '-q', other]);
  fs.writeFileSync(path.join(WT, '.git'), `gitdir: ${path.join(other, '.git')}\n`);
  const head = (await G.runGit(['rev-parse', 'HEAD'], { cwd: WT, gitDir: GD })).stdout.trim();
  assert.equal(head, remoteSha('refs/heads/lotse/readme-1a2b'));
  fs.writeFileSync(path.join(WT, '.git'), `gitdir: ${GD}\n`);
});

test('token: only as extraheader for the https clone host, never in config, output or errors', async () => {
  const env = G.gitEnv({ token: TOKEN });
  assert.ok(!Object.values(env).some(v => v.includes(TOKEN)), 'raw token not in env');
  assert.ok(!Object.keys(env).some(k => /extraheader/i.test(env[k])), 'no header for a file:// base');
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_CONFIG_GLOBAL, os.devNull);
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.ok(!('GITHUB_TOKEN' in env) && !('SHOPWARE_PASSWORD' in env));
  const cfg = (e: Record<string, string>) => Object.fromEntries(Array.from({ length: Number(e.GIT_CONFIG_COUNT) }, (_, i) => [e[`GIT_CONFIG_KEY_${i}`], e[`GIT_CONFIG_VALUE_${i}`]]));
  assert.equal(cfg(env)['core.hooksPath'], os.devNull);
  assert.equal(cfg(env)['protocol.allow'], 'never');
  assert.equal(cfg(env)['credential.helper'], '');

  process.env.LOTSE_GITHUB_CLONE_BASE = 'https://github.com';
  try {
    const https = cfg(G.gitEnv({ token: TOKEN }));
    assert.equal(https['http.https://github.com/.extraheader'], `Authorization: Basic ${BASIC}`);
    assert.equal(cfg(G.gitEnv({}))['http.https://github.com/.extraheader'], undefined, 'no header without auth');
    assert.equal(G.repoUrl('acme/plugin'), 'https://github.com/acme/plugin.git');
    const out = (await G.runGit(['config', '--get-regexp', 'extraheader'], { auth: true })).stdout;
    assert.match(out, /Authorization: Basic •••/);
    noLeak(out);
    const err = await G.runGit(['ls-remote', '--', 'https://127.0.0.1:1/acme/plugin.git'], { auth: true }).then(() => '', (e: Error) => e.message);
    assert.match(err, /^git ls-remote/);
    noLeak(err);
  } finally { process.env.LOTSE_GITHUB_CLONE_BASE = `file://${REMOTE}`; }
  noLeak(fs.readFileSync(path.join(GD, 'config'), 'utf8'));
});

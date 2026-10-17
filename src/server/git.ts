import 'server-only';
// The only place that runs git. Hardened executor:
// - execFile without a shell; repository and branch names are validated before they reach argv
// - minimal environment, no system/global config, no hooks, no fsmonitor, no credential helper, only https (file:// for tests on request)
// - the GitHub token goes only into the environment of one child process as an http.extraheader scoped to the clone host,
//   never into argv, URLs, .git/config or output (everything is redacted)
// - push targets are built here and limited to refs/heads/lotse/*; no force push except --force-with-lease on the task's own branch
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir } from './db';
import { assertRepoName, getGithubToken } from './github';
import { redact } from './settings';
import { singleton } from './state';

export { assertRepoName };

const DEFAULT_CLONE_BASE = 'https://github.com';
const TIMEOUT_MS = 120_000;
const CLONE_TIMEOUT_MS = 300_000;
const MAX_OUTPUT = 16 * 1024 * 1024;

/** Where repositories are cloned from: https://github.com, GitHub Enterprise or (tests) a local directory via file://. */
export const cloneBase = () => (process.env.LOTSE_GITHUB_CLONE_BASE || DEFAULT_CLONE_BASE).replace(/\/+$/, '');
export const repoUrl = (repo: string) => `${cloneBase()}/${assertRepoName(repo)}.git`;

const flags = () => singleton('git-flags', () => ({ allowFile: false }));
/** Tests only: allow file:// remotes (a local bare repository instead of GitHub). Never set by configuration. */
export const allowFileRemotesForTests = (on: boolean) => { flags().allowFile = on; };

export class GitError extends Error { constructor(message: string, readonly code: number | string | null = null) { super(message); this.name = 'GitError'; } }

export interface GitIdentity { name: string; email: string }
interface EnvOpts { token?: string | null; gitDir?: string; workTree?: string; identity?: GitIdentity }

/** Process environment for one git call: built from scratch, nothing from process.env except PATH, proxy and certificates. */
export function gitEnv(o: EnvOpts = {}): Record<string, string> {
  const home = path.join(dataDir(), 'home');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const e: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, LANG: 'C', LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_OPTIONAL_LOCKS: '0',
  };
  for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'GIT_SSL_CAINFO']) if (process.env[k]) e[k] = process.env[k] as string;
  const cfg: [string, string][] = [
    ['core.hooksPath', os.devNull], ['core.fsmonitor', 'false'], ['core.askPass', ''], ['credential.helper', ''],
    ['protocol.allow', 'never'], ['protocol.https.allow', 'always'], ['http.followRedirects', 'false'],
    ['submodule.recurse', 'false'], ['gc.auto', '0'], ['maintenance.auto', 'false'], ['commit.gpgSign', 'false'], ['tag.gpgSign', 'false'],
  ];
  if (flags().allowFile) cfg.push(['protocol.file.allow', 'always']);
  const base = cloneBase();
  if (o.token && base.startsWith('https://')) cfg.push([`http.${base}/.extraheader`, `Authorization: Basic ${Buffer.from(`x-access-token:${o.token}`).toString('base64')}`]);
  e.GIT_CONFIG_COUNT = String(cfg.length);
  cfg.forEach(([k, v], i) => { e[`GIT_CONFIG_KEY_${i}`] = k; e[`GIT_CONFIG_VALUE_${i}`] = v; });
  if (o.gitDir) { e.GIT_DIR = o.gitDir; if (o.workTree) e.GIT_WORK_TREE = o.workTree; }
  if (o.identity) { e.GIT_AUTHOR_NAME = e.GIT_COMMITTER_NAME = o.identity.name; e.GIT_AUTHOR_EMAIL = e.GIT_COMMITTER_EMAIL = o.identity.email; }
  return e;
}

/** Remove the token (raw and as Basic credential) and all other known secrets from git output. */
function scrubOut(text: string, token: string | null): string {
  let t = text;
  if (token) for (const v of [token, Buffer.from(`x-access-token:${token}`).toString('base64')]) t = t.split(v).join('•••');
  return redact(t);
}

export interface GitOpts { cwd?: string; gitDir?: string; auth?: boolean; signal?: AbortSignal; timeoutMs?: number; identity?: GitIdentity }

/** Run git with fixed arguments (no shell). auth = send the stored GitHub token to the clone host. Output is redacted. */
export function runGit(args: string[], o: GitOpts = {}): Promise<{ stdout: string; stderr: string }> {
  const token = o.auth ? getGithubToken() : null;
  const env = gitEnv({ token, gitDir: o.gitDir, workTree: o.gitDir ? o.cwd : undefined, identity: o.identity });
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: o.cwd ?? dataDir(), env: env as NodeJS.ProcessEnv, shell: false, timeout: o.timeoutMs ?? TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT, signal: o.signal, encoding: 'utf8', windowsHide: true },
      (err, stdout, stderr) => {
        const out = scrubOut(stdout, token), errText = scrubOut(stderr, token);
        if (!err) return resolve({ stdout: out, stderr: errText });
        const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
        const why = e.name === 'AbortError' ? 'abgebrochen' : e.killed ? 'Zeitüberschreitung' : e.code === 'ENOENT' ? 'git ist nicht installiert' : (errText.trim().split('\n').slice(-4).join(' ') || scrubOut(e.message, token));
        reject(new GitError(`git ${args[0]}: ${why}`.replace(/\s+/g, ' ').slice(0, 300), e.code ?? null));
      });
  });
}

// ---- Validation ----
/** Base branch chosen by the user (from GitHub's branch list): no leading '-', valid according to git check-ref-format. */
export async function assertBaseBranch(name: string): Promise<string> {
  if (typeof name !== 'string' || !name || name.length > 200 || name.startsWith('-') || name.includes('@{') || /[\s\x00-\x1f\x7f~^:?*[\\]/.test(name)) throw new Error('Ungültiger Branch-Name.');
  await runGit(['check-ref-format', '--branch', name]).catch(() => { throw new Error('Ungültiger Branch-Name.'); });
  return name;
}
/** Branches Lotse pushes to: always lotse/<slug>, built on the server. */
export function assertLotseBranch(name: string): string {
  if (typeof name !== 'string' || !/^lotse\/[a-z0-9][a-z0-9-]{2,60}$/.test(name)) throw new Error('Push nur auf Branches lotse/… erlaubt.');
  return name;
}
const assertSha = (s: string) => { if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(s)) throw new Error('Ungültiger Commit.'); return s; };
const assertAbs = (p: string, what: string) => { if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error(`${what}: absoluter Pfad erwartet.`); return path.resolve(p); };
const inside = (child: string, parent: string) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

// ---- Operations ----
/** Shallow clone of one branch; the git directory lives outside the worktree (the worktree only gets a .git file). */
export async function cloneRepo(repo: string, branch: string, worktree: string, gitDir: string, o: { signal?: AbortSignal } = {}): Promise<{ head: string }> {
  const url = repoUrl(repo);
  await assertBaseBranch(branch);
  const wt = assertAbs(worktree, 'Arbeitsordner'), gd = assertAbs(gitDir, 'Git-Ordner');
  if (inside(gd, wt) || inside(wt, gd)) throw new Error('Git-Ordner und Arbeitsordner müssen getrennt liegen.');
  if (fs.existsSync(gd)) throw new Error('Git-Ordner existiert bereits.');
  if (fs.existsSync(wt) && fs.readdirSync(wt).length) throw new Error('Arbeitsordner ist nicht leer.');
  fs.mkdirSync(path.dirname(wt), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(gd), { recursive: true, mode: 0o700 });
  const hadWt = fs.existsSync(wt);
  try {
    await runGit(['clone', '--depth', '50', '--single-branch', '--no-tags', '--template=', '--branch', branch, '--separate-git-dir', gd, '--', url, wt],
      { cwd: path.dirname(wt), auth: true, signal: o.signal, timeoutMs: CLONE_TIMEOUT_MS });
  } catch (e) {
    // git is killed with SIGKILL on timeout/abort and cannot clean up itself: remove what this call created so a retry works
    fs.rmSync(gd, { recursive: true, force: true });
    if (!hadWt) fs.rmSync(wt, { recursive: true, force: true });
    else for (const f of fs.readdirSync(wt)) fs.rmSync(path.join(wt, f), { recursive: true, force: true });
    throw e;
  }
  return { head: (await runGit(['rev-parse', 'HEAD'], { cwd: wt, gitDir: gd })).stdout.trim() };
}

const cleanMessage = (m: string) => m.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim().slice(0, 5000);
const assertIdentity = (p: GitIdentity, what: string): GitIdentity => {
  if (!p || !/^[^\n\r<>\x00]{1,100}$/.test(p.name ?? '') || !/^[^\s<>@]{1,64}@[^\s<>@]{1,190}$/.test(p.email ?? '')) throw new Error(`${what}: ungültiger Name oder E-Mail.`);
  return { name: p.name.trim(), email: p.email };
};

/** Stage everything and commit. null = nothing changed. */
export async function commitAll(worktree: string, gitDir: string, message: string, author: GitIdentity, coAuthor?: GitIdentity): Promise<string | null> {
  const o = { cwd: assertAbs(worktree, 'Arbeitsordner'), gitDir: assertAbs(gitDir, 'Git-Ordner') };
  const id = assertIdentity(author, 'Autor'), co = coAuthor ? assertIdentity(coAuthor, 'Co-Autor') : null;
  const msg = cleanMessage(message);
  if (!msg) throw new Error('Commit-Nachricht fehlt.');
  if (!(await runGit(['status', '--porcelain'], o)).stdout.trim()) return null;
  await runGit(['add', '-A', '--', '.'], o);
  await runGit(['commit', '--no-verify', '--no-gpg-sign', '-q', '-m', co ? `${msg}\n\nCo-Authored-By: ${co.name} <${co.email}>` : msg], { ...o, identity: id });
  return (await runGit(['rev-parse', 'HEAD'], o)).stdout.trim();
}

export interface PushTarget { repo: string; branch: string; worktree: string; gitDir: string; /** last SHA Lotse pushed to this branch: allows --force-with-lease on it */ pushedSha?: string | null }

/** Push HEAD to refs/heads/lotse/… of the task's repository. Never force; with pushedSha only --force-with-lease on exactly that state. */
export async function pushBranch(t: PushTarget, o: { signal?: AbortSignal } = {}): Promise<{ sha: string }> {
  const url = repoUrl(t.repo), branch = assertLotseBranch(t.branch);
  const g = { cwd: assertAbs(t.worktree, 'Arbeitsordner'), gitDir: assertAbs(t.gitDir, 'Git-Ordner') };
  const lease = t.pushedSha ? [`--force-with-lease=refs/heads/${branch}:${assertSha(t.pushedSha)}`] : [];
  await runGit(['push', '--porcelain', '--no-verify', ...lease, '--', url, `HEAD:refs/heads/${branch}`], { ...g, auth: true, signal: o.signal, timeoutMs: CLONE_TIMEOUT_MS });
  return { sha: (await runGit(['rev-parse', 'HEAD'], g)).stdout.trim() };
}

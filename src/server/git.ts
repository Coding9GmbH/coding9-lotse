import 'server-only';
// The only place that runs git. Hardened executor:
// - execFile without a shell; repository and branch names are validated before they reach argv
// - minimal environment, no system/global config, no hooks, no fsmonitor, no credential helper, only https (file:// for tests on request)
// - the GitHub token goes only into the environment of one child process as an http.extraheader scoped to the clone host,
//   never into argv, URLs, .git/config or output (everything is redacted)
// - push targets are built here and limited to refs/heads/lotse/*; no force push except --force-with-lease on the task's own branch
// - local commits of a sandbox (the agent's git_commit, publishing) only add a commit on top of HEAD: no amend, rebase, reset,
//   checkout or branch switch is offered anywhere, so the pushed history is always a fast-forward of what was pushed before
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

// E2E runs Lotse as its own process: there the switch is LOTSE_TEST_FILE_REMOTES=1, honoured only together with the fake Docker runner,
// or in a development server (next dev: the live check with real Docker containers). Never in a production build.
const flags = () => singleton('git-flags', () => ({ allowFile: process.env.LOTSE_TEST_FILE_REMOTES === '1' && (process.env.LOTSE_SANDBOX_RUNNER === 'fake' || process.env.NODE_ENV === 'development') }));
/** Tests only: allow file:// remotes (a local bare repository instead of GitHub). Never set by configuration. */
export const allowFileRemotesForTests = (on: boolean) => { flags().allowFile = on; };

/** `detail`: git's own report (refused refs and the end of stderr, token scrubbed, line breaks kept) for a precise error text. */
export class GitError extends Error { constructor(message: string, readonly code: number | string | null = null, readonly detail = '') { super(message); this.name = 'GitError'; } }

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
        const refused = out.split('\n').filter(l => l.startsWith('!')).join(' '); // push --porcelain reports rejected refs on stdout
        const why = e.name === 'AbortError' ? 'abgebrochen' : e.killed ? 'Zeitüberschreitung' : e.code === 'ENOENT' ? 'git ist nicht installiert' : ([refused, errText.trim().split('\n').slice(-4).join(' ')].filter(Boolean).join(' ') || scrubOut(e.message, token));
        const detail = [out.split('\n').filter(l => l.startsWith('!')).join('\n'), errText.trim()].filter(Boolean).join('\n').slice(-2000);
        reject(new GitError(`git ${args[0]}: ${why}`.replace(/\s+/g, ' ').slice(0, 300), e.code ?? null, detail));
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

/** "Ohne Projekt starten" (Sandbox Coding): an empty local repository in the same layout as a clone (worktree + separate git dir), with
 *  one empty commit on `branch` that also stands for origin/<branch> – the base everything (diff, commits, publishing) compares to. */
export async function initLocalRepo(branch: string, worktree: string, gitDir: string, author: GitIdentity): Promise<{ head: string }> {
  await assertBaseBranch(branch);
  const wt = assertAbs(worktree, 'Arbeitsordner'), gd = assertAbs(gitDir, 'Git-Ordner');
  if (inside(gd, wt) || inside(wt, gd)) throw new Error('Git-Ordner und Arbeitsordner müssen getrennt liegen.');
  if (fs.existsSync(gd)) throw new Error('Git-Ordner existiert bereits.');
  fs.mkdirSync(wt, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(gd), { recursive: true, mode: 0o700 });
  try {
    await runGit(['init', '-q', '--template=', `--initial-branch=${branch}`, '--separate-git-dir', gd, wt], { cwd: path.dirname(wt) });
    const o = { cwd: wt, gitDir: gd };
    await runGit(['commit', '--no-verify', '--no-gpg-sign', '-q', '--allow-empty', '-m', 'Sandbox ohne Projekt gestartet'], { ...o, identity: assertIdentity(author, 'Autor') });
    await runGit(['update-ref', `refs/remotes/origin/${branch}`, 'HEAD'], o);
    return { head: (await runGit(['rev-parse', 'HEAD'], o)).stdout.trim() };
  } catch (e) { fs.rmSync(gd, { recursive: true, force: true }); for (const f of fs.readdirSync(wt)) fs.rmSync(path.join(wt, f), { recursive: true, force: true }); throw e; }
}

/** "Als GitHub-Projekt anlegen": the local base (origin/<branch>, the empty start commit) becomes <branch> of the new, empty repository.
 *  Never forced: an existing branch there makes it fail. */
export async function pushBase(repo: string, branch: string, worktree: string, gitDir: string): Promise<void> {
  const url = repoUrl(repo);
  await assertBaseBranch(branch);
  const g = { cwd: assertAbs(worktree, 'Arbeitsordner'), gitDir: assertAbs(gitDir, 'Git-Ordner') };
  await runGit(['push', '--porcelain', '--no-verify', '--', url, `refs/remotes/origin/${branch}:refs/heads/${branch}`], { ...g, auth: true, timeoutMs: CLONE_TIMEOUT_MS });
}

const cleanMessage = (m: string) => m.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim().slice(0, 5000);
const assertIdentity = (p: GitIdentity, what: string): GitIdentity => {
  if (!p || !/^[^\n\r<>\x00]{1,100}$/.test(p.name ?? '') || !/^[^\s<>@]{1,64}@[^\s<>@]{1,190}$/.test(p.email ?? '')) throw new Error(`${what}: ungültiger Name oder E-Mail.`);
  return { name: p.name.trim(), email: p.email };
};

// Commands that write a task's index (diff's intent-to-add, commit's add) run one after another per git dir: two at once
// fail with "index.lock: File exists" (the Änderungen tab and the agent's git_diff ask at the same moment).
const indexQueues = () => singleton('git-index-queues', () => new Map<string, Promise<unknown>>());
function serialIndex<T>(gitDir: string, fn: () => Promise<T>): Promise<T> {
  const Q = indexQueues(), key = path.resolve(gitDir);
  const next = (Q.get(key) ?? Promise.resolve()).catch(() => {}).then(fn), tail = next.catch(() => {});
  Q.set(key, tail);
  void tail.then(() => { if (Q.get(key) === tail) Q.delete(key); });
  return next;
}

/** Stage everything and commit. null = nothing changed. */
export async function commitAll(worktree: string, gitDir: string, message: string, author: GitIdentity, coAuthor?: GitIdentity): Promise<string | null> {
  return serialIndex(gitDir, () => commitAllNow(worktree, gitDir, message, author, coAuthor));
}
async function commitAllNow(worktree: string, gitDir: string, message: string, author: GitIdentity, coAuthor?: GitIdentity): Promise<string | null> {
  const o = { cwd: assertAbs(worktree, 'Arbeitsordner'), gitDir: assertAbs(gitDir, 'Git-Ordner') };
  const id = assertIdentity(author, 'Autor'), co = coAuthor ? assertIdentity(coAuthor, 'Co-Autor') : null;
  const msg = cleanMessage(message);
  if (!msg) throw new Error('Commit-Nachricht fehlt.');
  if (!(await runGit(['status', '--porcelain'], o)).stdout.trim()) return null;
  await runGit(['add', '-A', '--', '.'], o);
  await runGit(['commit', '--no-verify', '--no-gpg-sign', '-q', '-m', co ? `${msg}\n\nCo-Authored-By: ${co.name} <${co.email}>` : msg], { ...o, identity: id });
  return (await runGit(['rev-parse', 'HEAD'], o)).stdout.trim();
}

/** Limits of a commit message from the agent (git_commit): a short first line, a bounded body, a bounded list of paths. */
export const COMMIT_LIMITS = { subject: 120, message: 2000, paths: 100 } as const;
/** A path for git_commit: relative to the worktree, no "..", no leading "-" or "/", no control characters, never .git. Throws in German. */
export function assertCommitPath(p: string): string {
  const v = typeof p === 'string' ? p.trim().replace(/^\.\/+/, '').replace(/\/+$/, '') : '';
  if (!v || v.length > 500 || v.startsWith('-') || v.startsWith('/') || v.includes('\\') || /[\x00-\x1f\x7f]/.test(v) || v.split('/').some(x => x === '..' || x === '.git' || x === ''))
    throw new Error(`Ungültiger Pfad für den Commit: „${String(p).slice(0, 120)}“ (relativ zum Repository, ohne „..“ und .git).`);
  return v;
}
/** The agent's commit message: control characters removed, a first line of at most COMMIT_LIMITS.subject and a total of COMMIT_LIMITS.message. */
export function commitMessage(m: string): string {
  const msg = cleanMessage(String(m ?? '')).replace(/\n{3,}/g, '\n\n');
  if (!msg) throw new Error('Commit-Nachricht fehlt.');
  const subject = msg.split('\n')[0];
  if (subject.length > COMMIT_LIMITS.subject) throw new Error(`Die erste Zeile der Commit-Nachricht ist zu lang (${subject.length} Zeichen, höchstens ${COMMIT_LIMITS.subject}).`);
  if (msg.length > COMMIT_LIMITS.message) throw new Error(`Die Commit-Nachricht ist zu lang (höchstens ${COMMIT_LIMITS.message} Zeichen).`);
  return msg;
}

/** Uncommitted changes of the worktree (also new files), optionally only below `paths`: path and git's status letter
 *  (M, A, D, R; "?" for a new file). Read-only. */
export async function pendingChanges(worktree: string, gitDir: string, paths?: string[]): Promise<{ path: string; status: string }[]> {
  const o = { cwd: assertAbs(worktree, 'Arbeitsordner'), gitDir: assertAbs(gitDir, 'Git-Ordner') };
  const spec = paths?.length ? paths.map(assertCommitPath) : [];
  return serialIndex(o.gitDir, async () => parsePorcelain((await runGit(['--literal-pathspecs', '-c', 'core.quotePath=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...(spec.length ? spec : ['.'])], o)).stdout));
}
/** `git status --porcelain=v1 -z`: "XY path\0", a rename "XY new\0old\0". */
function parsePorcelain(out: string): { path: string; status: string }[] {
  const parts = out.split('\0'), res: { path: string; status: string }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2), file = e.slice(3);
    // the index only ever holds intent-to-add entries (diffAgainstBase): " A" is a new file like "??"
    const code = xy === '??' ? '?' : xy.includes('R') ? 'R' : xy.includes('D') ? 'D' : xy.includes('A') ? 'A' : 'M';
    res.push({ path: file, status: code });
    if (code === 'R') { const old = parts[++i]; if (old) res.push({ path: old, status: 'R' }); }
  }
  return res;
}

/** A staged file as the commit check sees it: path, git's status letter (A, M, D, T) and its staged bytes (null = deleted). */
export type StagedReader = (path: string) => Promise<Buffer | null>;
/** Checks what is staged before it is committed; returns the reason to refuse, or null. `head`: the commit the new one goes on top of. */
export type CommitVerifier = (staged: { path: string; status: string }[], head: string, read: StagedReader) => Promise<string | null>;

/**
 * The agent's commit in a sandbox worktree (git_commit): stages all changes or only `paths` and adds ONE commit on top of HEAD.
 * Nothing else: no push, no amend, no branch switch, no hooks, no signing. Author and co-author like publishing. null = nothing to commit.
 * `verify` checks exactly the staged blobs – what the commit will hold, not the files on disk, which another tool call of the same
 * turn may change meanwhile – all in one step of the index queue; a refusal resets the index to HEAD and returns `{ blocked }`.
 */
export async function commitChanges(worktree: string, gitDir: string, message: string, author: GitIdentity, coAuthor?: GitIdentity, paths?: string[], verify?: CommitVerifier): Promise<{ sha: string; files: number } | { blocked: string } | null> {
  const o = { cwd: assertAbs(worktree, 'Arbeitsordner'), gitDir: assertAbs(gitDir, 'Git-Ordner') };
  const id = assertIdentity(author, 'Autor'), co = coAuthor ? assertIdentity(coAuthor, 'Co-Autor') : null;
  const msg = commitMessage(message);
  if ((paths?.length ?? 0) > COMMIT_LIMITS.paths) throw new Error(`Höchstens ${COMMIT_LIMITS.paths} Pfade je Commit.`);
  const spec = paths?.length ? [...new Set(paths.map(assertCommitPath))] : [];
  return serialIndex(o.gitDir, async () => {
    const pending = parsePorcelain((await runGit(['--literal-pathspecs', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...(spec.length ? spec : ['.'])], o)).stdout);
    if (!pending.length) return null;
    const idle = spec.filter(x => !pending.some(c => c.path === x || c.path.startsWith(`${x}/`)));
    if (idle.length) throw new Error(`Keine Änderungen an: ${idle.slice(0, 5).join(', ')}.`); // git add would fail on a path that matches nothing
    const lit = ['--literal-pathspecs'];
    const head = (await runGit(['rev-parse', 'HEAD'], o)).stdout.trim();
    await runGit([...lit, 'add', '-A', '--', ...(spec.length ? spec : ['.'])], o);
    // the whole index against HEAD is what `git commit` (without paths) records; intent-to-add entries (diffAgainstBase) are neither listed nor committed
    const out = (await runGit(['-c', 'core.quotePath=false', 'diff', '--cached', '--name-status', '-z', '--no-renames', '--no-ext-diff', 'HEAD', '--'], o)).stdout.split('\0');
    const staged: { path: string; status: string }[] = [];
    for (let i = 0; i + 1 < out.length; i += 2) if (out[i]) staged.push({ status: out[i][0], path: out[i + 1] });
    if (!staged.length) return null;
    const reset = () => runGit(['reset', '-q'], o).catch(() => {});
    try {
      const why = verify ? await verify(staged, head, p => (/^[^\x00-\x1f]+$/.test(p) ? rawGit(['cat-file', 'blob', `:0:${p}`], o.cwd, o.gitDir) : Promise.resolve(null))) : null;
      if (why) { await reset(); return { blocked: why }; }
    } catch (e) { await reset(); throw e; }
    await runGit(['commit', '--no-verify', '--no-gpg-sign', '-q', '-m', co ? `${msg}\n\nCo-Authored-By: ${co.name} <${co.email}>` : msg], { ...o, identity: id });
    return { sha: (await runGit(['rev-parse', 'HEAD'], o)).stdout.trim(), files: staged.length };
  });
}

export interface LocalCommit { sha: string; at: string; subject: string; /** contained in the last push (pushedSha) */ published: boolean }
/** Commits on top of the cloned base branch (newest first, at most `max`), each marked whether the last push contains it. Read-only. */
export async function localCommits(worktree: string, gitDir: string, baseBranch: string, pushedSha?: string | null, max = 50): Promise<LocalCommit[]> {
  const o = { cwd: assertAbs(worktree, 'Arbeitsordner'), gitDir: assertAbs(gitDir, 'Git-Ordner') };
  const ref = `refs/remotes/origin/${await assertBaseBranch(baseBranch)}`;
  const out = (await runGit(['log', '--no-color', `--max-count=${Math.max(1, Math.min(200, max))}`, '--format=%H%x1f%aI%x1f%s', `${ref}..HEAD`, '--'], o)).stdout;
  const list = out.split('\n').filter(Boolean).map(l => { const [sha, at, subject] = l.split('\x1f'); return { sha, at, subject: subject ?? '' }; });
  let unpushed: Set<string> | null = null;
  if (pushedSha && list.length) {
    unpushed = await runGit(['rev-list', '--max-count=500', `${assertSha(pushedSha)}..HEAD`, '--'], o).then(r => new Set(r.stdout.split('\n').filter(Boolean)), () => null);
  }
  return list.map(c => ({ ...c, published: !!unpushed && !unpushed.has(c.sha) }));
}

export interface PushTarget { repo: string; branch: string; worktree: string; gitDir: string; /** last SHA Lotse pushed to this branch: allows --force-with-lease on it */ pushedSha?: string | null }

/** Push HEAD to refs/heads/lotse/… of the task's repository. Never force; with pushedSha only --force-with-lease on exactly that state. */
export async function pushBranch(t: PushTarget, o: { signal?: AbortSignal } = {}): Promise<{ sha: string }> {
  const url = repoUrl(t.repo), branch = assertLotseBranch(t.branch);
  const g = { cwd: assertAbs(t.worktree, 'Arbeitsordner'), gitDir: assertAbs(t.gitDir, 'Git-Ordner') };
  // a lease on the last pushed SHA, unless the branch is gone on GitHub (deleted after a merge): then it is created anew, still without force
  const exists = t.pushedSha ? !!(await runGit(['ls-remote', '--heads', '--', url, `refs/heads/${branch}`], { ...g, auth: true, signal: o.signal })).stdout.trim() : false;
  const lease = t.pushedSha && exists ? [`--force-with-lease=refs/heads/${branch}:${assertSha(t.pushedSha)}`] : [];
  await runGit(['push', '--porcelain', '--no-verify', ...lease, '--', url, `HEAD:refs/heads/${branch}`], { ...g, auth: true, signal: o.signal, timeoutMs: CLONE_TIMEOUT_MS });
  return { sha: (await runGit(['rev-parse', 'HEAD'], g)).stdout.trim() };
}

/** stdout of a local git call as raw bytes, NOT redacted (null on any error): only for checks on the server, never returned to a
 *  client or the AI. No auth, no network. */
function rawGit(args: string[], worktree: string, gitDir: string): Promise<Buffer | null> {
  const cwd = assertAbs(worktree, 'Arbeitsordner'), gd = assertAbs(gitDir, 'Git-Ordner');
  const env = gitEnv({ gitDir: gd, workTree: cwd });
  return new Promise(resolve => {
    execFile('git', args, { cwd, env: env as NodeJS.ProcessEnv, shell: false, timeout: TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT, encoding: 'buffer', windowsHide: true },
      (err, stdout) => resolve(err ? null : stdout));
  });
}

/** Raw bytes of a file in the cloned base branch (null if it is not there). Local, no auth; NOT redacted: only for checks on the
 *  server (the secret scan compares lines byte for byte), never returned to a client or the AI. */
export function readBaseBlob(worktree: string, gitDir: string, baseBranch: string, file: string, at?: string): Promise<Buffer | null> {
  if (!/^[^\x00-\x1f]+$/.test(file) || file.startsWith('/') || file.split('/').includes('..')) return Promise.resolve(null);
  // `at`: a commit (e.g. the last pushed one) instead of the base branch
  return (at ? Promise.resolve(assertSha(at)) : assertBaseBranch(baseBranch).then(b => `refs/remotes/origin/${b}`))
    .then(ref => rawGit(['cat-file', 'blob', `${ref}:${file}`], worktree, gitDir));
}

/** Full messages (subject and body) of the local commits not pushed yet – since `pushedSha`, else since the cloned base branch –
 *  as one text, NOT redacted: for the publish secret scan only. */
export async function unpublishedMessages(worktree: string, gitDir: string, baseBranch: string, pushedSha?: string | null): Promise<string> {
  const from = pushedSha ? assertSha(pushedSha) : `refs/remotes/origin/${await assertBaseBranch(baseBranch)}`;
  const out = await rawGit(['log', '--no-color', '--max-count=500', '--format=%B%x00', `${from}..HEAD`, '--'], worktree, gitDir);
  if (!out) throw new Error('Die Commit-Nachrichten konnten nicht gelesen werden.');
  return out.toString('utf8');
}

/** Whether the worktree differs from the last pushed commit: uncommitted changes (also new files) or a HEAD other than `sha`. */
export async function changedSince(worktree: string, gitDir: string, sha: string): Promise<boolean> {
  const o = { cwd: assertAbs(worktree, 'Arbeitsordner'), gitDir: assertAbs(gitDir, 'Git-Ordner') };
  return serialIndex(o.gitDir, async () => {
    if ((await runGit(['rev-parse', 'HEAD'], o)).stdout.trim() !== assertSha(sha)) return true;
    return !!(await runGit(['status', '--porcelain', '--untracked-files=all'], o)).stdout.trim();
  });
}

/** Working tree (including new files) against the cloned base branch: numstat, name-status and the patch. Read-only, no auth.
 *  New files are marked intent-to-add in the task's own index so they show up; nothing is staged or committed. */
export async function diffAgainstBase(worktree: string, gitDir: string, baseBranch: string): Promise<{ numstat: string; status: string; patch: string }> {
  const o = { cwd: assertAbs(worktree, 'Arbeitsordner'), gitDir: assertAbs(gitDir, 'Git-Ordner') };
  const ref = `refs/remotes/origin/${await assertBaseBranch(baseBranch)}`;
  return serialIndex(o.gitDir, async () => {
    await runGit(['add', '--intent-to-add', '--', '.'], o);
    const base = ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', ref];
    const [numstat, status, patch] = await Promise.all([runGit([...base, '--numstat'], o), runGit([...base, '--name-status'], o), runGit(base, o)]);
    return { numstat: numstat.stdout, status: status.stdout, patch: patch.stdout };
  });
}

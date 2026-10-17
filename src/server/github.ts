import 'server-only';
// GitHub: fine-grained personal access token (encrypted in the DB), REST calls only from the server.
// The token never leaves the server: not to the AI, the browser, logs, the workspace or a command line.
// Base URL can be overridden via environment (tests with a local fake, GitHub Enterprise): LOTSE_GITHUB_API_BASE.
import type { GithubBranch, GithubPublic, GithubRepo, GithubTestResult } from '@/lib/protocol';
import { kvGet, kvSet, seal, unseal } from './db';
import { fetchWithRetry } from './retry';
import { errMsg } from './util';

const DEFAULT_API = 'https://api.github.com';
const TIMEOUT_MS = 20_000;
const MAX_PAGES = 5;
export const apiBase = () => (process.env.LOTSE_GITHUB_API_BASE || DEFAULT_API).replace(/\/+$/, '');

interface StoredGithub { token?: string; login?: string; updatedAt?: string }
const KV = 'github';
const stored = () => kvGet<StoredGithub>(KV) ?? {};

/** Fine-grained (github_pat_…) or classic (ghp_…) token; anything else is rejected before it is stored. */
export function normToken(t: string): string {
  const s = t.trim();
  if (!/^(github_pat_[A-Za-z0-9_]{30,255}|ghp_[A-Za-z0-9]{30,255})$/.test(s)) throw new Error('Das sieht nicht wie ein GitHub-Token aus (beginnt mit github_pat_ oder ghp_).');
  return s;
}

/** Repository as owner/name; checked before it reaches a URL or a git command line. */
export function assertRepoName(repo: string): string {
  if (typeof repo !== 'string' || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo) || repo.length > 200 || /\/\.\.?$/.test(repo)) throw new Error('Ungültiger Repository-Name (erwartet: besitzer/name).');
  return repo;
}

/** Server-only: decrypted token or null. */
export const getGithubToken = (): string | null => unseal(stored().token);
export const githubConnected = () => !!getGithubToken();

export function githubPublic(): GithubPublic {
  const s = stored();
  return { hasToken: !!s.token, login: s.token ? s.login ?? null : null, updatedAt: s.updatedAt ?? null };
}

/** Save: token empty/undefined = unchanged, null = disconnect. A new token forgets the login until the next test. */
export function saveGithub(p: { token?: string | null }) {
  if (p.token === null) { kvSet(KV, {}); return; }
  if (!p.token) return;
  kvSet(KV, { token: seal(normToken(p.token)) ?? undefined, updatedAt: new Date().toISOString() } satisfies StoredGithub);
}
/** Only if the tested token is still the stored one: a token saved meanwhile must not get the old token's login. */
const rememberLogin = (sealed: string, login: string) => { const s = stored(); if (s.token && s.token === sealed) kvSet(KV, { ...s, login }); };

// ---- REST calls ----
const clip = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 300);
/** Error text without any token, at most 300 characters. */
export function scrub(text: string, token = getGithubToken()): string {
  let t = text;
  if (token) t = t.split(token).join('•••');
  return clip(t.replace(/(github_pat_|gh[pousr]_)[A-Za-z0-9_]{8,}/g, '$1•••'));
}

/** One GitHub API call with the stored token. `path` starts with / and is built by the caller from validated parts. */
export async function ghFetch<T = unknown>(path: string, init: { method?: string; body?: unknown; /** If-None-Match: 304 returns data null */ etag?: string } = {}): Promise<{ data: T; headers: Headers }> {
  const token = getGithubToken();
  if (!token) throw new Error('Noch kein GitHub-Token gespeichert.');
  const method = init.method ?? 'GET';
  const send = () => fetch(`${apiBase()}${path}`, {
    method, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Lotse', ...(init.etag ? { 'if-none-match': init.etag } : {}), ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const r = await (method === 'GET' ? fetchWithRetry(send, { label: 'github' }) : send())
    .catch((e: Error & { cause?: { code?: string } }) => { throw new Error(e.name === 'TimeoutError' ? 'GitHub antwortet nicht (Timeout).' : scrub(`GitHub nicht erreichbar: ${e.cause?.code || e.message}`, token)); });
  if (r.status === 304 && init.etag) { await r.body?.cancel().catch(() => {}); return { data: null as T, headers: r.headers }; } // unchanged (does not count against the rate limit)
  const text = await r.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* handled below */ }
  if (!r.ok) {
    const j = json && typeof json === 'object' ? json as { message?: unknown; errors?: { message?: unknown }[] } : {};
    // 422 carries the reason in errors[] ("A pull request already exists for …", "No commits between …")
    const detail = Array.isArray(j.errors) ? j.errors.map(e => (typeof e?.message === 'string' ? e.message : '')).filter(Boolean).join('; ') : '';
    const msg = [typeof j.message === 'string' ? j.message : '', detail].filter(Boolean).join(': ');
    if (r.status >= 300 && r.status < 400) throw new Error('GitHub leitet um: Repository wurde umbenannt oder verschoben, bitte neu auswählen.');
    if (r.status === 401) throw new Error('GitHub lehnt den Token ab (ungültig, abgelaufen oder widerrufen).');
    if (r.status === 404) throw new Error('Nicht gefunden oder kein Zugriff: Ist das Repository für den Token freigegeben?');
    if (r.status === 403 || r.status === 429) throw new Error(scrub(r.headers.get('x-ratelimit-remaining') === '0' ? 'GitHub-Anfragelimit erreicht, bitte später erneut versuchen.' : `GitHub verweigert den Zugriff (${r.status})${msg ? `: ${msg}` : ''}. Token-Berechtigungen prüfen.`, token));
    throw new Error(scrub(`GitHub: HTTP ${r.status}${msg ? ` – ${msg}` : ''}`, token));
  }
  if (json === null && text) throw new Error('GitHub: unerwartete Antwort (kein JSON).');
  return { data: json as T, headers: r.headers };
}

/** All pages of a list endpoint (100 per page, at most MAX_PAGES). */
async function ghList<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data } = await ghFetch<T[]>(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Array.isArray(data)) throw new Error('GitHub: unerwartete Antwort (keine Liste).');
    out.push(...data);
    if (data.length < 100) break;
  }
  return out;
}

interface RawRepo { full_name?: unknown; private?: unknown; default_branch?: unknown; pushed_at?: unknown; archived?: unknown; permissions?: { push?: unknown } }
const toRepo = (r: RawRepo): GithubRepo => ({
  fullName: String(r.full_name ?? ''), private: r.private === true, defaultBranch: String(r.default_branch ?? 'main'),
  push: r.permissions?.push === true && r.archived !== true, pushedAt: typeof r.pushed_at === 'string' ? r.pushed_at : null,
});
const repoPath = (repo: string) => `/repos/${assertRepoName(repo).split('/').map(encodeURIComponent).join('/')}`;

export async function getUser(): Promise<{ login: string }> {
  const { data } = await ghFetch<{ login?: unknown }>('/user');
  if (typeof data?.login !== 'string') throw new Error('GitHub: unerwartete Antwort (kein Login).');
  return { login: data.login };
}

/** Repositories the token can see (with a fine-grained token: only the selected ones), most recently pushed first. */
export async function listRepos(): Promise<GithubRepo[]> {
  return (await ghList<RawRepo>('/user/repos?sort=pushed')).map(toRepo).filter(r => /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(r.fullName));
}

export async function listBranches(repo: string): Promise<GithubBranch[]> {
  return (await ghList<{ name?: unknown; protected?: unknown }>(`${repoPath(repo)}/branches`))
    .filter(b => typeof b.name === 'string').map(b => ({ name: b.name as string, protected: b.protected === true }));
}

/** Can the token see the repository and may it push? 404 = no access (GitHub hides repositories without access). */
export async function checkRepoAccess(repo: string): Promise<GithubRepo> {
  try { return toRepo((await ghFetch<RawRepo>(repoPath(repo))).data); }
  catch (e) { throw new Error(/Nicht gefunden/.test(errMsg(e)) ? `Kein Zugriff auf ${repo}: Repository fehlt oder ist für den Token nicht freigegeben.` : errMsg(e)); }
}

export const PERMISSION_HINT = 'Token braucht Contents + Pull requests: Lesen & Schreiben.';

/** Check the connection: who is the token, how many repositories are released, which ones lack write access. */
export async function testGithub(): Promise<GithubTestResult> {
  const sealed = stored().token;
  if (!sealed || !getGithubToken()) return { ok: false, message: 'Noch kein Token gespeichert.', login: null, repos: null, readOnly: [] };
  const { login } = await getUser();
  rememberLogin(sealed, login);
  const repos = await listRepos();
  const readOnly = repos.filter(r => !r.push).map(r => r.fullName).slice(0, 20);
  if (!repos.length) return { ok: false, login, repos: 0, readOnly, message: `Verbunden als ${login}, aber der Token sieht kein Repository. Repositorys beim Token freigeben. ${PERMISSION_HINT}` };
  const ro = readOnly.length ? ` Ohne Schreibrecht: ${readOnly.slice(0, 5).join(', ')}${readOnly.length > 5 ? ' …' : ''}.` : '';
  return { ok: true, login, repos: repos.length, readOnly, message: `Verbunden als ${login}, ${repos.length} ${repos.length === 1 ? 'Repository' : 'Repositorys'} sichtbar.${ro} ${PERMISSION_HINT}` };
}

// ---- Pull requests (Sandbox Coding): head is always a lotse/… branch of the same repository, built by the caller ----
interface RawPull { number?: unknown; html_url?: unknown; title?: unknown; state?: unknown; merged?: unknown; merged_at?: unknown; draft?: unknown; head?: { sha?: unknown; ref?: unknown } }
export interface Pull { number: number; url: string; title: string; state: 'open' | 'closed' | 'merged'; draft: boolean; headSha: string | null }
const toPull = (p: RawPull): Pull => {
  if (typeof p?.number !== 'number' || typeof p.html_url !== 'string') throw new Error('GitHub: unerwartete Antwort (kein Pull Request).');
  return { number: p.number, url: p.html_url, title: typeof p.title === 'string' ? p.title : '', state: p.merged === true || typeof p.merged_at === 'string' ? 'merged' : p.state === 'closed' ? 'closed' : 'open',
    draft: p.draft === true, headSha: typeof p.head?.sha === 'string' ? p.head.sha : null };
};
const assertPullNo = (n: number) => { if (!Number.isInteger(n) || n < 1) throw new Error('Ungültige Pull-Request-Nummer.'); return n; };

/** The open pull request whose head is `branch` of the repository itself (owner:branch), or null. */
export async function findOpenPull(repo: string, branch: string): Promise<Pull | null> {
  const owner = assertRepoName(repo).split('/')[0];
  const { data } = await ghFetch<RawPull[]>(`${repoPath(repo)}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=10`);
  if (!Array.isArray(data)) throw new Error('GitHub: unerwartete Antwort (keine Liste).');
  return data.length ? toPull(data[0]) : null;
}
export async function createPull(repo: string, p: { title: string; body: string; head: string; base: string }): Promise<Pull> {
  return toPull((await ghFetch<RawPull>(`${repoPath(repo)}/pulls`, { method: 'POST', body: { title: p.title, body: p.body, head: p.head, base: p.base, draft: false, maintainer_can_modify: false } })).data);
}
export async function updatePull(repo: string, n: number, p: { title: string; body: string }): Promise<Pull> {
  return toPull((await ghFetch<RawPull>(`${repoPath(repo)}/pulls/${assertPullNo(n)}`, { method: 'PATCH', body: { title: p.title, body: p.body } })).data);
}
export async function getPull(repo: string, n: number): Promise<Pull> {
  return toPull((await ghFetch<RawPull>(`${repoPath(repo)}/pulls/${assertPullNo(n)}`)).data);
}
/** Check runs of a commit, counted: success (also neutral/skipped), failure (failure, timed out, cancelled, action required), pending. */
export async function checkSummary(repo: string, sha: string): Promise<{ total: number; success: number; failure: number; pending: number }> {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Ungültiger Commit.');
  const { data } = await ghFetch<{ check_runs?: { status?: unknown; conclusion?: unknown }[] }>(`${repoPath(repo)}/commits/${sha}/check-runs?per_page=100`);
  const runs = Array.isArray(data?.check_runs) ? data.check_runs : [];
  const s = { total: runs.length, success: 0, failure: 0, pending: 0 };
  for (const r of runs) {
    if (r.status !== 'completed') s.pending++;
    else if (['success', 'neutral', 'skipped'].includes(String(r.conclusion))) s.success++;
    else s.failure++;
  }
  return s;
}

// ---- Feedback on a pull request (pr-watch.ts): conditional GETs, raw lists; the caller filters, redacts and caps ----
/** A list read with If-None-Match: null = unchanged since `etag`. */
export interface Conditional<T> { data: T[] | null; etag: string | null }
async function ghConditional<T>(path: string, etag?: string | null): Promise<Conditional<T>> {
  const { data, headers } = await ghFetch<T[] | { check_runs?: T[] } | null>(path, { etag: etag ?? undefined });
  if (data === null) return { data: null, etag: etag ?? null };
  const list = Array.isArray(data) ? data : Array.isArray(data?.check_runs) ? data.check_runs : null;
  if (!list) throw new Error('GitHub: unerwartete Antwort (keine Liste).');
  return { data: list, etag: headers.get('etag') };
}
export interface RawUser { login?: unknown; type?: unknown }
export interface RawReview { id?: unknown; user?: RawUser | null; state?: unknown; body?: unknown; html_url?: unknown }
export interface RawComment { id?: unknown; user?: RawUser | null; body?: unknown; html_url?: unknown; path?: unknown; line?: unknown; original_line?: unknown }
export interface RawCheckRun { id?: unknown; name?: unknown; status?: unknown; conclusion?: unknown; html_url?: unknown; output?: { title?: unknown; summary?: unknown } | null }
/** The pull request with If-None-Match: data null = unchanged. */
export async function getPullIfChanged(repo: string, n: number, etag?: string | null): Promise<{ pull: Pull | null; etag: string | null }> {
  const { data, headers } = await ghFetch<RawPull | null>(`${repoPath(repo)}/pulls/${assertPullNo(n)}`, { etag: etag ?? undefined });
  return data === null ? { pull: null, etag: etag ?? null } : { pull: toPull(data), etag: headers.get('etag') };
}
/** First 100 of each (enough for a sandbox PR): reviews, line comments, comments on the conversation, check runs of the head commit. */
export const listReviews = (repo: string, n: number, etag?: string | null) => ghConditional<RawReview>(`${repoPath(repo)}/pulls/${assertPullNo(n)}/reviews?per_page=100`, etag);
export const listReviewComments = (repo: string, n: number, etag?: string | null) => ghConditional<RawComment>(`${repoPath(repo)}/pulls/${assertPullNo(n)}/comments?per_page=100`, etag);
export const listIssueComments = (repo: string, n: number, etag?: string | null) => ghConditional<RawComment>(`${repoPath(repo)}/issues/${assertPullNo(n)}/comments?per_page=100`, etag);
export function listCheckRuns(repo: string, sha: string, etag?: string | null) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Ungültiger Commit.');
  return ghConditional<RawCheckRun>(`${repoPath(repo)}/commits/${sha}/check-runs?per_page=100`, etag);
}

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
const rememberLogin = (login: string) => { const s = stored(); if (s.token) kvSet(KV, { ...s, login }); };

// ---- REST calls ----
const clip = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 300);
/** Error text without any token, at most 300 characters. */
export function scrub(text: string, token = getGithubToken()): string {
  let t = text;
  if (token) t = t.split(token).join('•••');
  return clip(t.replace(/(github_pat_|gh[pousr]_)[A-Za-z0-9_]{8,}/g, '$1•••'));
}

/** One GitHub API call with the stored token. `path` starts with / and is built by the caller from validated parts. */
export async function ghFetch<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ data: T; headers: Headers }> {
  const token = getGithubToken();
  if (!token) throw new Error('Noch kein GitHub-Token gespeichert.');
  const method = init.method ?? 'GET';
  const send = () => fetch(`${apiBase()}${path}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Lotse', ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const r = await (method === 'GET' ? fetchWithRetry(send, { label: 'github' }) : send())
    .catch((e: Error & { cause?: { code?: string } }) => { throw new Error(e.name === 'TimeoutError' ? 'GitHub antwortet nicht (Timeout).' : scrub(`GitHub nicht erreichbar: ${e.cause?.code || e.message}`, token)); });
  const text = await r.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* handled below */ }
  if (!r.ok) {
    const msg = json && typeof json === 'object' && typeof (json as { message?: unknown }).message === 'string' ? (json as { message: string }).message : '';
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
  if (!getGithubToken()) return { ok: false, message: 'Noch kein Token gespeichert.', login: null, repos: null, readOnly: [] };
  const { login } = await getUser();
  rememberLogin(login);
  const repos = await listRepos();
  const readOnly = repos.filter(r => !r.push).map(r => r.fullName).slice(0, 20);
  if (!repos.length) return { ok: false, login, repos: 0, readOnly, message: `Verbunden als ${login}, aber der Token sieht kein Repository. Repositorys beim Token freigeben. ${PERMISSION_HINT}` };
  const ro = readOnly.length ? ` Ohne Schreibrecht: ${readOnly.slice(0, 5).join(', ')}${readOnly.length > 5 ? ' …' : ''}.` : '';
  return { ok: true, login, repos: repos.length, readOnly, message: `Verbunden als ${login}, ${repos.length} ${repos.length === 1 ? 'Repository' : 'Repositorys'} sichtbar.${ro} ${PERMISSION_HINT}` };
}

// For tests and local checks only: tiny fake of the GitHub REST API (Bearer token, JSON, 404 for repositories without access).
// Endpoints: /user, /user/repos, /repos/:o/:r, /repos/:o/:r/branches, /repos/:o/:r/contents (root names from FakeRepo.files), GET (head/state filter) + POST /repos/:o/:r/pulls,
// GET + PATCH /repos/:o/:r/pulls/:n, GET /repos/:o/:r/commits/:sha/check-runs, GET /repos/:o/:r/pulls/:n/reviews, …/pulls/:n/comments
// and …/issues/:n/comments (feedback, keyed "owner/repo#n"). Every GET answers with an ETag and 304 on a matching If-None-Match.
// GET /__fake/calls (no auth): the calls so far; POST /__fake/feedback: add feedback to a pull request or merge it (E2E).
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRepo { fullName: string; private?: boolean; defaultBranch?: string; push?: boolean; branches?: string[]; /** names in the root (GET …/contents); default: a plugin's */ files?: string[] }
export interface FakePull { number: number; title: string; head: string; base: string; body: string; html_url: string; state: 'open' | 'closed'; merged?: boolean; draft?: boolean; headSha?: string }
export interface FakeCheckRun { id?: number; name: string; status: 'queued' | 'in_progress' | 'completed'; conclusion?: string | null; html_url?: string; output?: { title?: string; summary?: string } }
export interface FakeUser { login: string; type?: string }
export interface FakeReview { id: number; user: FakeUser; state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'PENDING' | 'DISMISSED'; body: string; html_url?: string }
export interface FakeComment { id: number; user: FakeUser; body: string; html_url?: string; path?: string; line?: number | null }
export interface FakeGithub {
  base: string;
  calls: { method: string; path: string; auth: string | null; body: unknown; /** If-None-Match sent */ inm?: string }[];
  repos: FakeRepo[];
  pulls: Record<string, FakePull[]>;
  /** check runs per commit sha */
  checkRuns: Record<string, FakeCheckRun[]>;
  /** feedback per pull request, keyed "owner/repo#n" */
  reviews: Record<string, FakeReview[]>;
  reviewComments: Record<string, FakeComment[]>;
  issueComments: Record<string, FakeComment[]>;
  /** next response has this status/message */
  failNext?: { status: number; message: string; headers?: Record<string, string> };
  /** the next request whose path contains `path` has this status/message (once) */
  failOn?: { path: string; status: number; message: string };
  /** requests whose path contains `path` wait for `until` before they are answered (once each, while set) */
  holdOn?: { path: string; until: Promise<void> };
  close: () => Promise<void>;
}

const read = (req: http.IncomingMessage) => new Promise<string>(res => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => res(b)); });

export async function startFakeGithub(o: { token: string; login?: string; repos?: FakeRepo[]; port?: number }): Promise<FakeGithub> {
  const f = { calls: [], repos: o.repos ?? [], pulls: {}, checkRuns: {}, reviews: {}, reviewComments: {}, issueComments: {} } as unknown as FakeGithub;
  const pullJson = (pr: FakePull) => ({ ...pr, head: { ref: pr.head, sha: pr.headSha ?? 'f'.repeat(40) }, base: { ref: pr.base }, merged: pr.merged ?? false, draft: pr.draft ?? false });
  const repoJson = (r: FakeRepo) => ({ full_name: r.fullName, name: r.fullName.split('/')[1], private: r.private ?? true, default_branch: r.defaultBranch ?? 'main', pushed_at: '2026-10-01T10:00:00Z', archived: false, permissions: { admin: false, push: r.push ?? true, pull: true } });
  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      const text = JSON.stringify(body);
      if (req.method === 'GET' && status === 200) {
        const etag = `"${crypto.createHash('sha1').update(text).digest('hex')}"`;
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag }); res.end(); return; }
        headers = { ...headers, etag };
      }
      res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(text);
    };
    const url = new URL(req.url ?? '/', 'http://x'), p = url.pathname, raw = await read(req);
    if (p === '/__fake/calls') return send(200, f.calls);
    if (p === '/__fake/feedback' && req.method === 'POST') { // E2E: feedback on a pull request, or merge it
      const b = JSON.parse(raw) as { repo: string; number: number; reviews?: FakeReview[]; issueComments?: FakeComment[]; checkRuns?: FakeCheckRun[]; merged?: boolean };
      const k = `${b.repo}#${b.number}`, pr = (f.pulls[b.repo] ?? []).find(x => x.number === b.number);
      if (!pr) return send(404, { message: 'Not Found' });
      (f.reviews[k] ??= []).push(...(b.reviews ?? []));
      (f.issueComments[k] ??= []).push(...(b.issueComments ?? []));
      (f.checkRuns[pr.headSha ?? 'f'.repeat(40)] ??= []).push(...(b.checkRuns ?? []));
      if (b.merged) { pr.state = 'closed'; pr.merged = true; }
      return send(200, { ok: true });
    }
    const auth = req.headers.authorization ?? null;
    let body: unknown = null; try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    f.calls.push({ method: req.method ?? 'GET', path: `${p}${url.search}`, auth, body, ...(req.headers['if-none-match'] ? { inm: String(req.headers['if-none-match']) } : {}) });
    if (auth !== `Bearer ${o.token}`) return send(401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' });
    if (req.headers['x-github-api-version'] !== '2022-11-28' || !String(req.headers.accept).includes('vnd.github+json')) return send(400, { message: 'Missing API version headers' });
    if (f.failNext) { const e = f.failNext; f.failNext = undefined; return send(e.status, { message: e.message }, e.headers); }
    if (f.failOn && p.includes(f.failOn.path)) { const e = f.failOn; f.failOn = undefined; return send(e.status, { message: e.message }); }
    if (f.holdOn && p.includes(f.holdOn.path)) await f.holdOn.until;
    if (p === '/user') return send(200, { login: o.login ?? 'octo-lotse', id: 1 });
    if (p === '/user/repos') {
      const per = Number(url.searchParams.get('per_page') ?? 30), page = Number(url.searchParams.get('page') ?? 1);
      return send(200, f.repos.slice((page - 1) * per, page * per).map(repoJson));
    }
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/branches|\/contents|\/pulls(?:\/(\d+))?|\/commits\/([0-9a-f]{40})\/check-runs|\/(pulls|issues)\/(\d+)\/(reviews|comments))?$/.exec(p);
    const repo = m && f.repos.find(r => r.fullName === `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`);
    if (!m || !repo) return send(404, { message: 'Not Found' });
    if (!m[3]) return send(200, repoJson(repo));
    if (m[3] === '/branches') return send(200, (repo.branches ?? [repo.defaultBranch ?? 'main']).map(name => ({ name, protected: name === (repo.defaultBranch ?? 'main'), commit: { sha: '0'.repeat(40) } })));
    if (m[3] === '/contents') return send(200, (repo.files ?? ['composer.json', 'src', 'README.md']).map(name => ({ name, type: name.includes('.') ? 'file' : 'dir' })));
    if (m[5]) { const runs = f.checkRuns[m[5]] ?? []; return send(200, { total_count: runs.length, check_runs: runs }); }
    if (m[6]) {
      const k = `${repo.fullName}#${m[7]}`;
      if (m[8] === 'reviews') return m[6] === 'pulls' ? send(200, f.reviews[k] ?? []) : send(404, { message: 'Not Found' });
      return send(200, (m[6] === 'pulls' ? f.reviewComments : f.issueComments)[k] ?? []);
    }
    const list = (f.pulls[repo.fullName] ??= []);
    if (m[4]) {
      const pr = list.find(x => x.number === Number(m[4]));
      if (!pr) return send(404, { message: 'Not Found' });
      if (req.method === 'PATCH') {
        if (repo.push === false) return send(403, { message: 'Resource not accessible by personal access token' });
        const b = (body ?? {}) as Partial<FakePull>;
        if (typeof b.title === 'string') pr.title = b.title;
        if (typeof b.body === 'string') pr.body = b.body;
      }
      return send(200, pullJson(pr));
    }
    if (req.method === 'POST') {
      if (repo.push === false) return send(403, { message: 'Resource not accessible by personal access token' });
      const b = (body ?? {}) as Record<string, string>;
      if (list.some(x => x.state === 'open' && x.head === b.head)) return send(422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message: `A pull request already exists for ${repo.fullName.split('/')[0]}:${b.head}.` }] });
      const pr: FakePull = { number: list.length + 1, title: b.title, head: b.head, base: b.base, body: b.body ?? '', html_url: `https://github.com/${repo.fullName}/pull/${list.length + 1}`, state: 'open', draft: (b as { draft?: unknown }).draft === true };
      list.push(pr);
      return send(201, pullJson(pr));
    }
    // GET: ?head=owner:branch and ?state=open|closed|all (default open) as on GitHub
    const head = url.searchParams.get('head'), state = url.searchParams.get('state') ?? 'open';
    return send(200, list.filter(x => (state === 'all' || x.state === state) && (!head || `${repo.fullName.split('/')[0]}:${x.head}` === head)).map(pullJson));
  });
  await new Promise<void>(r => server.listen(o.port ?? 0, '127.0.0.1', r));
  f.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  f.close = () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); });
  return f;
}

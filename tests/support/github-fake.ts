// For tests and local checks only: tiny fake of the GitHub REST API (Bearer token, JSON, 404 for repositories without access).
// Endpoints: /user, /user/repos, /repos/:o/:r, /repos/:o/:r/branches, GET + POST /repos/:o/:r/pulls.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRepo { fullName: string; private?: boolean; defaultBranch?: string; push?: boolean; branches?: string[] }
export interface FakePull { number: number; title: string; head: string; base: string; body: string; html_url: string; state: 'open' | 'closed' }
export interface FakeGithub {
  base: string;
  calls: { method: string; path: string; auth: string | null; body: unknown }[];
  repos: FakeRepo[];
  pulls: Record<string, FakePull[]>;
  /** next response has this status/message */
  failNext?: { status: number; message: string; headers?: Record<string, string> };
  close: () => Promise<void>;
}

const read = (req: http.IncomingMessage) => new Promise<string>(res => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => res(b)); });

export async function startFakeGithub(o: { token: string; login?: string; repos?: FakeRepo[] }): Promise<FakeGithub> {
  const f = { calls: [], repos: o.repos ?? [], pulls: {} } as unknown as FakeGithub;
  const repoJson = (r: FakeRepo) => ({ full_name: r.fullName, name: r.fullName.split('/')[1], private: r.private ?? true, default_branch: r.defaultBranch ?? 'main', pushed_at: '2026-10-01T10:00:00Z', archived: false, permissions: { admin: false, push: r.push ?? true, pull: true } });
  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    const url = new URL(req.url ?? '/', 'http://x'), p = url.pathname, raw = await read(req);
    const auth = req.headers.authorization ?? null;
    let body: unknown = null; try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    f.calls.push({ method: req.method ?? 'GET', path: `${p}${url.search}`, auth, body });
    if (auth !== `Bearer ${o.token}`) return send(401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' });
    if (req.headers['x-github-api-version'] !== '2022-11-28' || !String(req.headers.accept).includes('vnd.github+json')) return send(400, { message: 'Missing API version headers' });
    if (f.failNext) { const e = f.failNext; f.failNext = undefined; return send(e.status, { message: e.message }, e.headers); }
    if (p === '/user') return send(200, { login: o.login ?? 'octo-lotse', id: 1 });
    if (p === '/user/repos') {
      const per = Number(url.searchParams.get('per_page') ?? 30), page = Number(url.searchParams.get('page') ?? 1);
      return send(200, f.repos.slice((page - 1) * per, page * per).map(repoJson));
    }
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/branches|\/pulls)?$/.exec(p);
    const repo = m && f.repos.find(r => r.fullName === `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`);
    if (!m || !repo) return send(404, { message: 'Not Found' });
    if (!m[3]) return send(200, repoJson(repo));
    if (m[3] === '/branches') return send(200, (repo.branches ?? [repo.defaultBranch ?? 'main']).map(name => ({ name, protected: name === (repo.defaultBranch ?? 'main'), commit: { sha: '0'.repeat(40) } })));
    const list = (f.pulls[repo.fullName] ??= []);
    if (req.method === 'POST') {
      if (!repo.push) return send(403, { message: 'Resource not accessible by personal access token' });
      const b = (body ?? {}) as Record<string, string>;
      const pr: FakePull = { number: list.length + 1, title: b.title, head: b.head, base: b.base, body: b.body ?? '', html_url: `https://github.com/${repo.fullName}/pull/${list.length + 1}`, state: 'open' };
      list.push(pr);
      return send(201, pr);
    }
    return send(200, list);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  f.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  f.close = () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); });
  return f;
}

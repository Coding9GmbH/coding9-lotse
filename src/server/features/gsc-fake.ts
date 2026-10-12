// Nur für Tests und lokale Prüfung: winziger Fake von Google OAuth (JWT-Bearer) und Search Console API (sites.list, searchanalytics.query).
// Prüft die JWT-Signatur mit dem öffentlichen Schlüssel, Scope, aud und Laufzeit wie Google; Daten kommen aus einer Liste von Tageszeilen.
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRow { date: string; page: string; query: string; clicks: number; impressions: number; position: number }
export interface FakeGoogle {
  base: string; tokenUrl: string; apiBase: string;
  stats: { token: number; query: number; sites: number; bodies: Record<string, unknown>[] };
  sites: { siteUrl: string; permissionLevel: string }[];
  data: FakeRow[];
  close: () => Promise<void>;
}

const b64json = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
const read = (req: http.IncomingMessage) => new Promise<string>(res => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => res(b)); });

export async function startFakeGoogle(publicKey: crypto.KeyObject | string, o: { clientEmail: string; data?: FakeRow[]; sites?: FakeGoogle['sites'] }): Promise<FakeGoogle> {
  const tokens = new Set<string>();
  const f = { stats: { token: 0, query: 0, sites: 0, bodies: [] }, sites: o.sites ?? [], data: o.data ?? [] } as unknown as FakeGoogle;
  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const url = new URL(req.url ?? '/', 'http://x'), body = await read(req);
    if (req.method === 'POST' && url.pathname === '/token') {
      f.stats.token++;
      const p = new URLSearchParams(body), jwt = p.get('assertion') ?? '';
      if (p.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') return send(400, { error: 'unsupported_grant_type' });
      const [h, c, sig] = jwt.split('.');
      try {
        const head = b64json(h), claims = b64json(c), now = Math.floor(Date.now() / 1000);
        if (head.alg !== 'RS256') return send(400, { error: 'invalid_grant', error_description: 'alg' });
        if (!crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(sig, 'base64url'))) return send(400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
        if (claims.iss !== o.clientEmail || claims.scope !== 'https://www.googleapis.com/auth/webmasters.readonly' || claims.aud !== f.tokenUrl || claims.exp - claims.iat !== 3600 || Math.abs(claims.iat - now) > 300) return send(400, { error: 'invalid_grant', error_description: 'claims' });
      } catch { return send(400, { error: 'invalid_grant', error_description: 'malformed' }); }
      const t = `ya29.fake-${crypto.randomBytes(8).toString('hex')}`; tokens.add(t);
      return send(200, { access_token: t, expires_in: 3599, token_type: 'Bearer' });
    }
    const auth = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!tokens.has(auth)) return send(401, { error: { code: 401, message: 'Request had invalid authentication credentials.' } });
    if (req.method === 'GET' && url.pathname === '/webmasters/v3/sites') { f.stats.sites++; return send(200, { siteEntry: f.sites }); }
    const m = url.pathname.match(/^\/webmasters\/v3\/sites\/([^/]+)\/searchAnalytics\/query$/);
    if (req.method === 'POST' && m) {
      f.stats.query++;
      const site = decodeURIComponent(m[1]);
      if (!f.sites.some(s => s.siteUrl === site)) return send(403, { error: { code: 403, message: `User does not have sufficient permission for site '${site}'.` } });
      const q = JSON.parse(body); f.stats.bodies.push(q);
      const dims: string[] = q.dimensions ?? [], filters: { dimension: 'page' | 'query'; operator: string; expression: string }[] = q.dimensionFilterGroups?.[0]?.filters ?? [];
      const match = (r: FakeRow) => r.date >= q.startDate && r.date <= q.endDate && filters.every(x => {
        const v = r[x.dimension];
        switch (x.operator) { case 'equals': return v === x.expression; case 'contains': return v.includes(x.expression); case 'notContains': return !v.includes(x.expression); case 'includingRegex': return new RegExp(x.expression).test(v); case 'excludingRegex': return !new RegExp(x.expression).test(v); default: return false; }
      });
      const groups = new Map<string, { keys: string[]; clicks: number; impressions: number; pos: number }>();
      for (const r of f.data.filter(match)) {
        const keys = dims.map(d => String(r[d as keyof FakeRow])), k = JSON.stringify(keys), g = groups.get(k) ?? { keys, clicks: 0, impressions: 0, pos: 0 };
        g.clicks += r.clicks; g.impressions += r.impressions; g.pos += r.position * r.impressions; groups.set(k, g);
      }
      const rows = [...groups.values()].map(g => ({ ...(dims.length ? { keys: g.keys } : {}), clicks: g.clicks, impressions: g.impressions, ctr: g.impressions ? g.clicks / g.impressions : 0, position: g.impressions ? g.pos / g.impressions : 0 }))
        .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
      const start = q.startRow ?? 0, limit = Math.min(q.rowLimit ?? 1000, 25000);
      const page = rows.slice(start, start + limit);
      return send(200, page.length ? { rows: page, responseAggregationType: 'byPage' } : { responseAggregationType: 'byPage' });
    }
    send(404, { error: { code: 404, message: 'not found' } });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  f.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  f.tokenUrl = `${f.base}/token`; f.apiBase = `${f.base}/webmasters/v3`;
  f.close = () => new Promise(r => { server.closeAllConnections(); server.close(() => r()); });
  return f;
}

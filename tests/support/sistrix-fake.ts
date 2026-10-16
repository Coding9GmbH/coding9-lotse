// For tests and local checks only: tiny fake of the Sistrix API (POST /<method>, api_key + parameters in the form body, JSON envelope).
// The envelope (method/answer/credits, numbers as text) follows what Sistrix returns; the data comes from `data` per method.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeSistrix {
  base: string;
  calls: { method: string; params: Record<string, string> }[];
  /** Response rows per method (answer[0][<key>]); key = value after the method name */
  data: Record<string, unknown[]>;
  /** next response is an error of this kind */
  failNext?: { code: string; message: string };
  close: () => Promise<void>;
}

const read = (req: http.IncomingMessage) => new Promise<string>(res => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => res(b)); });

export async function startFakeSistrix(o: { apiKey: string; data?: FakeSistrix['data'] }): Promise<FakeSistrix> {
  const f = { calls: [], data: o.data ?? {} } as unknown as FakeSistrix;
  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const method = (req.url ?? '/').split('?')[0].replace(/^\//, ''), body = new URLSearchParams(await read(req));
    const params = Object.fromEntries(body.entries());
    if (req.method !== 'POST') return send(405, { status: 'fail', error: [{ error_code: '405', error_message: 'POST erwartet' }] });
    if ((req.url ?? '').includes('api_key')) return send(400, { status: 'fail', error: [{ error_code: '400', error_message: 'Schlüssel gehört in den Body' }] });
    if (params.api_key !== o.apiKey) return send(200, { status: 'fail', error: [{ error_code: '101', error_message: 'Invalid API key' }] });
    delete params.api_key;
    if (method.startsWith('domain.') && !('domain' in params || 'host' in params || 'path' in params || 'url' in params)) return send(200, { status: 'fail', error: [{ error_code: '2000', error_message: 'domain not found' }] });
    f.calls.push({ method, params });
    if (f.failNext) { const e = f.failNext; f.failNext = undefined; return send(200, { status: 'fail', error: [{ error_code: e.code, error_message: e.message }] }); }
    if (method === 'credits') return send(200, { method: ['credits'], answer: [{ credits: [{ value: 1234 }] }], credits: [{ used: '0' }] });
    const limit = Number(params.limit ?? 100), page = Math.max(Number(params.page ?? 1), 1), rows = (f.data[method] ?? []).slice((page - 1) * limit, page * limit);
    const key = method.split('.').at(-1)!;
    // like Sistrix: the URLs of an issue type are nested in {count, "optimizer.onpage.issue": [...]}
    if (method === 'project.onpage.issue') return send(200, { method: [['optimizer.onpage.issue']], answer: [{ 'optimizer.onpage.issue': [{ count: rows.length, 'optimizer.onpage.issue': rows }] }], credits: [{ used: '0' }] });
    return send(200, { method: [method], answer: [{ [key]: rows }], credits: [{ used: String(rows.length) }] });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  f.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  f.close = () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); });
  return f;
}

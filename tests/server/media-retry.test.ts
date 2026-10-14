import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-media-retry-'));

const media = new Map<string, { id: string }>();
const calls: string[] = [];
let dropUpload = false;
const srv = http.createServer((q, r) => {
  const chunks: Buffer[] = [];
  q.on('data', c => chunks.push(c));
  q.on('end', () => {
    const url = new URL(q.url!, 'http://x'), p = url.pathname, method = q.method ?? 'GET';
    calls.push(`${method} ${p}`);
    const send = (status = 204, body: unknown = null) => { r.statusCode = status; r.setHeader('content-type', 'application/json'); r.end(body == null ? '' : JSON.stringify(body)); };
    const raw = Buffer.concat(chunks);
    const body = q.headers['content-type']?.includes('json') && raw.length ? JSON.parse(raw.toString('utf8')) : {};
    if (p === '/api/oauth/token') return send(200, { access_token: 'tok', expires_in: 600 });
    if (p === '/api/search/media-default-folder') return send(200, { data: [{ folder: { id: 'folder' } }] });
    if (p === '/api/search/media') {
      const ids: string[] = body.ids ?? [];
      const rows = [...media.values()].filter(m => !ids.length || ids.includes(m.id));
      return send(200, { data: rows });
    }
    if (p === '/api/media' && method === 'POST') { media.set(body.id, { id: body.id }); return send(); }
    const del = p.match(/^\/api\/media\/([a-f0-9]+)$/);
    if (del && method === 'DELETE') { media.delete(del[1]); return send(); }
    if (del && method === 'PATCH') return send();
    const up = p.match(/^\/api\/_action\/media\/([a-f0-9]+)\/upload$/);
    if (up && method === 'POST') {
      if (dropUpload) { q.socket?.destroy(); return; }
      return send();
    }
    send(404, { errors: [{ detail: `${method} ${p}` }] });
  });
});
await new Promise<void>(res => srv.listen(0, '127.0.0.1', res));
after(() => srv.close());
const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

test('Media upload: a timeout after creation deletes the media record', async () => {
  const { Shopware } = await import('../../src/server/shopware');
  const sw = new Shopware({ url: base, publicUrl: base, user: 'a', password: 'b', clientId: '', clientSecret: '' });
  dropUpload = true;
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  await assert.rejects(sw.uploadMediaBinary(png, { ext: 'png', mime: 'image/png', fileName: 'vase' }), /fetch failed|ECONNRESET|socket|nicht erreichbar|Zeitlimit|aborted|other side closed/i);
  dropUpload = false;
  assert.equal(media.size, 0, 'created record was deleted');
  assert.ok(calls.some(c => c.startsWith('DELETE /api/media/')));
});

test('URL import: the same call does not create the file a second time', async () => {
  const { Shopware } = await import('../../src/server/shopware');
  const { importFromUrl, setFetcher, setTrustedOrigins } = await import('../../src/server/media');
  setTrustedOrigins(async () => ['https://cdn.example.com']);
  setFetcher(async () => new Response(Buffer.from('bild'), { status: 200, headers: { 'content-type': 'image/jpeg' } }));
  const sw = new Shopware({ url: base, publicUrl: base, user: 'a', password: 'b', clientId: '', clientSecret: '' });
  const before = media.size;
  const a = await importFromUrl(sw, 'https://cdn.example.com/vase.jpg', { alt: 'Vase' });
  const b = await importFromUrl(sw, 'https://cdn.example.com/vase.jpg', { alt: 'Vase' });
  assert.equal(a.mediaId, b.mediaId);
  assert.equal(media.size, before + 1, 'no second media');
});

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { NextRequest } from 'next/server';
import type { ChatEvent } from '@/lib/protocol';

// Image attachment on Shopware: /api/upload only stages (staged:…), the upload to media management happens only when an approved
// change set is applied (exactly once per image), undo restores the product images.
process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-upload-staging-'));
for (const k of Object.keys(process.env)) if (/^(SHOPWARE_|SHOPIFY_|MAGENTO_|OPENMAGE_|SHOP_PLATFORM$)/.test(k)) delete process.env[k];

// Fake Shopware: one product with one image; media, uploads and product-image assignments are tracked
type Media = { id: string; url: string; fileName: string; fileExtension: string; mimeType: string; alt?: string | null; title?: string | null };
type Pm = { id: string; mediaId: string; position: number };
const media = new Map<Media['id'], Media>([['m1', { id: 'm1', url: 'http://shop/media/vase.jpg', fileName: 'vase', fileExtension: 'jpg', mimeType: 'image/jpeg' }]]);
const product = { id: 'p1', productNumber: 'HH-VASE-22', name: 'Vase', translated: { name: 'Vase' }, parentId: null, coverId: 'pm1', media: [{ id: 'pm1', mediaId: 'm1', position: 0 }] as Pm[] };
const uploads: { id: string; bytes: number; fileName: string }[] = [], requests: string[] = [];
const pmRows = () => product.media.map(pm => ({ ...pm, media: media.get(pm.mediaId) ?? null }));
const srv = http.createServer((q, r) => {
  const chunks: Buffer[] = []; q.on('data', c => chunks.push(c));
  q.on('end', () => {
    const raw = Buffer.concat(chunks), url = new URL(q.url!, 'http://x'), p = url.pathname;
    requests.push(`${q.method} ${p}`);
    const send = (o: unknown, status = 200) => { r.statusCode = status; r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(o)); };
    const body = q.headers['content-type']?.startsWith('application/json') && raw.length ? JSON.parse(raw.toString('utf8')) : {};
    if (p === '/api/oauth/token') return send({ access_token: 'tok', expires_in: 600 });
    if (p === '/api/search/product') return send({ total: 1, data: [{ ...product, media: pmRows() }] });
    if (p === '/api/search/media') { const rows = [...media.values()].filter(m => !body.ids || body.ids.includes(m.id)); return send({ total: rows.length, data: rows }); }
    if (p === '/api/search/media-default-folder') return send({ total: 1, data: [{ entity: body.filter?.[0]?.value, folder: { id: 'folder-product' } }] });
    if (p === '/api/search/sales-channel') return send({ total: 0, data: [] });
    if (p === '/api/media' && q.method === 'POST') { media.set(body.id, { id: body.id, url: '', fileName: '', fileExtension: '', mimeType: '' }); return send(null, 204); }
    const up = p.match(/^\/api\/_action\/media\/([a-f0-9]+)\/upload$/);
    if (up && q.method === 'POST') {
      const m = media.get(up[1]); if (!m) return send({ errors: [{ code: 'nf', detail: up[1] }] }, 404);
      const fileName = url.searchParams.get('fileName')!, ext = url.searchParams.get('extension')!;
      Object.assign(m, { fileName, fileExtension: ext, mimeType: q.headers['content-type'], url: `http://shop/media/${fileName}.${ext}` });
      uploads.push({ id: m.id, bytes: raw.length, fileName }); return send(null, 204);
    }
    const patchMedia = p.match(/^\/api\/media\/([a-f0-9]+)$/);
    if (patchMedia && q.method === 'PATCH') { Object.assign(media.get(patchMedia[1])!, body); return send(null, 204); }
    if (p === '/api/product/p1' && q.method === 'PATCH') {
      if (body.media) product.media = (body.media as Partial<Pm>[]).map(row => ({ id: row.id!, mediaId: row.mediaId ?? product.media.find(x => x.id === row.id)!.mediaId, position: row.position ?? 0 }));
      if ('coverId' in body) product.coverId = body.coverId; return send(null, 204);
    }
    const delPm = p.match(/^\/api\/product-media\/([a-z0-9]+)$/);
    if (delPm && q.method === 'DELETE') { product.media = product.media.filter(x => x.id !== delPm[1]); return send(null, 204); }
    if (p === '/api/product-media' && q.method === 'POST') { product.media.push({ id: body.id, mediaId: body.mediaId, position: body.position }); return send(null, 204); }
    send({ errors: [{ code: 'nf', detail: `${q.method} ${p}` }] }, 404);
  });
});
await new Promise<void>(res => srv.listen(0, '127.0.0.1', res));
after(() => srv.close());
const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

const { updateSettings } = await import('../../src/server/settings');
const { reconfigureAll } = await import('../../src/server/platform');
const { getSession, decideChange, undoChangeSet } = await import('../../src/server/sessions');
const { kvGet } = await import('../../src/server/db');
const { stagedFile } = await import('../../src/server/media');
const { buildProductImagesChangeSet } = await import('../../src/server/features/product-images');
const { POST: upload } = await import('../../src/app/api/upload/route');
await import('../../src/server/features'); // registers the executor for product images
updateSettings({ platform: 'shopware', shopware: { url: base, user: 'admin', password: 'geheim' } });
reconfigureAll();

const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const tick = () => new Promise(r => setTimeout(r, 5));
let staged: { mediaId: string; url: string; fileName: string };

test('POST /api/upload: SVG with script is rejected and not stored', async () => {
  const dir = path.join(process.env.AICB_DATA!, 'staging');
  const before = new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : []);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
  const r = await upload(new NextRequest('http://127.0.0.1/api/upload?name=boese', { method: 'POST', headers: { 'content-type': 'image/svg+xml' }, body: svg }));
  assert.equal(r.status, 400);
  assert.match(await r.text(), /SVG abgelehnt/);
  const after = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  for (const f of after) {
    if (before.has(f) || !f.endsWith('.svg')) continue;
    assert.doesNotMatch(fs.readFileSync(path.join(dir, f), 'utf8'), /<script/i);
  }
});

test('POST /api/upload: clean SVG gets xmlns and stays script-free', async () => {
  const svg = '<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>';
  const r = await upload(new NextRequest('http://127.0.0.1/api/upload?name=quadrat', { method: 'POST', headers: { 'content-type': 'image/svg+xml' }, body: svg }));
  assert.equal(r.status, 200);
  const staged = await r.json() as { fileName: string };
  const file = stagedFile([staged.fileName]);
  assert.ok(file, 'preview file exists');
  const text = fs.readFileSync(file!.path, 'utf8');
  assert.match(text, /xmlns=/);
  assert.doesNotMatch(text, /<script/i);
});

test('POST /api/upload (Shopware): image is only staged, no access to the shop', async () => {
  const r = await upload(new NextRequest(`http://127.0.0.1/api/upload?name=${encodeURIComponent('Becher Foto.png')}`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: png }));
  assert.equal(r.status, 200);
  staged = await r.json();
  assert.match(staged.mediaId, /^staged:[a-z0-9]+$/);
  assert.equal(staged.url, `/staged/${staged.fileName}`);
  assert.ok(stagedFile([staged.fileName]), 'preview file for the UI/view_image exists');
  assert.deepEqual(requests, [], 'nothing sent to the shop');
  assert.equal(uploads.length, 0);
});

test('Attachment → propose_product_images → approval → apply uploads exactly once → undo restores the images', async () => {
  const s = getSession('upload-e2e'); s.running = true;
  s.emit = (ev: ChatEvent) => { s.events.push(ev); };
  const approve = async () => {
    const approvalId = (s.events.findLast(e => e.t === 'changeset') as { approvalId: string }).approvalId;
    assert.ok(decideChange('upload-e2e', approvalId, true));
  };
  const propose = () => buildProductImagesChangeSet(s.sw, { title: 'Foto zum Becher', reason: 'Nutzerwunsch', products: [{ productId: 'p1', add: [{ image: staged.mediaId, cover: true }] }] }, () => 'pmneu');
  const cs = await propose();
  assert.equal(cs.items.length, 1);
  assert.ok(cs.assets?.some(a => a.url === staged.url), 'change set shows the preview of the staged image');
  assert.equal(uploads.length, 0, 'proposal uploads nothing');

  const pending = s.requestChange(cs); await tick(); await approve();
  const out = await pending;
  assert.equal(out.status, 'applied', JSON.stringify(out));
  assert.equal(uploads.length, 1, 'exactly one upload on apply');
  assert.match(uploads[0].fileName, /^becher-foto-/); assert.equal(uploads[0].bytes, png.length);
  const newMediaId = uploads[0].id;
  assert.deepEqual(product.media.map(m => m.mediaId), ['m1', newMediaId], 'without position, at the end'); assert.equal(product.coverId, 'pmneu');
  assert.equal(kvGet<Record<string, string>>('staging_map')?.[staged.mediaId.slice(7)], newMediaId, 'mapping staged → mediaId remembered');

  // the same image in a second change set: no second upload
  const cs2 = await buildProductImagesChangeSet(s.sw, { title: 'Nochmal', reason: 'r', products: [{ productId: 'p1', add: [{ image: staged.mediaId }] }] }, () => 'pmzwei');
  const pending2 = s.requestChange(cs2); await tick(); await approve();
  assert.equal((await pending2).status, 'applied');
  assert.equal(uploads.length, 1, 'already uploaded: reused');
  assert.deepEqual(product.media.map(m => m.mediaId), ['m1', newMediaId, newMediaId]);

  // undo (last first): product as before again, the media stays in media management
  for (const id of [cs2.id, cs.id]) { const u = await undoChangeSet('upload-e2e', id); assert.ok(u?.ok, JSON.stringify(u)); }
  assert.deepEqual(product.media, [{ id: 'pm1', mediaId: 'm1', position: 0 }]); assert.equal(product.coverId, 'pm1');
  assert.ok(media.has(newMediaId)); assert.ok(!requests.some(r => r.startsWith('DELETE /api/media/')));
  s.running = false;
});

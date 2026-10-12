import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { NextRequest } from 'next/server';
import type { ChatEvent } from '@/lib/protocol';

// Bild-Anhang auf Shopware: /api/upload merkt nur vor (staged:…), der Upload in die Medienverwaltung passiert erst beim Anwenden eines freigegebenen
// Änderungssets (genau einmal je Bild), Rückgängig stellt die Produktbilder wieder her.
process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-upload-staging-'));
for (const k of Object.keys(process.env)) if (/^(SHOPWARE_|SHOPIFY_|MAGENTO_|OPENMAGE_|SHOP_PLATFORM$)/.test(k)) delete process.env[k];

// Fake-Shopware: ein Produkt mit einem Bild; Medien, Uploads und Produkt-Bild-Zuordnungen werden mitgeführt
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

const { updateSettings } = await import('./settings');
const { reconfigureAll } = await import('./platform');
const { getSession, decideChange, undoChangeSet } = await import('./sessions');
const { kvGet } = await import('./db');
const { stagedFile } = await import('./media');
const { buildProductImagesChangeSet } = await import('./features/bilder');
const { POST: upload } = await import('../app/api/upload/route');
await import('./features'); // registriert den Executor für Produktbilder
updateSettings({ platform: 'shopware', shopware: { url: base, user: 'admin', password: 'geheim' } });
reconfigureAll();

const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const tick = () => new Promise(r => setTimeout(r, 5));
let staged: { mediaId: string; url: string; fileName: string };

test('POST /api/upload (Shopware): Bild wird nur vorgemerkt, kein Zugriff auf den Shop', async () => {
  const r = await upload(new NextRequest(`http://127.0.0.1/api/upload?name=${encodeURIComponent('Becher Foto.png')}`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: png }));
  assert.equal(r.status, 200);
  staged = await r.json();
  assert.match(staged.mediaId, /^staged:[a-z0-9]+$/);
  assert.equal(staged.url, `/staged/${staged.fileName}`);
  assert.ok(stagedFile([staged.fileName]), 'Vorschau-Datei für die Oberfläche/view_image vorhanden');
  assert.deepEqual(requests, [], 'nichts in Richtung Shop');
  assert.equal(uploads.length, 0);
});

test('Anhang → propose_product_images → Freigabe → Anwenden lädt genau einmal hoch → Rückgängig stellt die Bilder wieder her', async () => {
  const s = getSession('upload-e2e'); s.running = true;
  s.emit = (ev: ChatEvent) => { s.events.push(ev); };
  const approve = async () => {
    const approvalId = (s.events.findLast(e => e.t === 'changeset') as { approvalId: string }).approvalId;
    assert.ok(decideChange('upload-e2e', approvalId, true));
  };
  const propose = () => buildProductImagesChangeSet(s.sw, { title: 'Foto zum Becher', reason: 'Nutzerwunsch', products: [{ productId: 'p1', add: [{ image: staged.mediaId, cover: true }] }] }, () => 'pmneu');
  const cs = await propose();
  assert.equal(cs.items.length, 1);
  assert.ok(cs.assets?.some(a => a.url === staged.url), 'Änderungsset zeigt die Vorschau des vorgemerkten Bilds');
  assert.equal(uploads.length, 0, 'Vorschlag lädt nichts hoch');

  const pending = s.requestChange(cs); await tick(); await approve();
  const out = await pending;
  assert.equal(out.status, 'applied', JSON.stringify(out));
  assert.equal(uploads.length, 1, 'genau ein Upload beim Anwenden');
  assert.match(uploads[0].fileName, /^becher-foto-/); assert.equal(uploads[0].bytes, png.length);
  const newMediaId = uploads[0].id;
  assert.deepEqual(product.media.map(m => m.mediaId), ['m1', newMediaId], 'ohne position ans Ende'); assert.equal(product.coverId, 'pmneu');
  assert.equal(kvGet<Record<string, string>>('staging_map')?.[staged.mediaId.slice(7)], newMediaId, 'Zuordnung staged → mediaId gemerkt');

  // dasselbe Bild in einem zweiten Änderungsset: kein zweiter Upload
  const cs2 = await buildProductImagesChangeSet(s.sw, { title: 'Nochmal', reason: 'r', products: [{ productId: 'p1', add: [{ image: staged.mediaId }] }] }, () => 'pmzwei');
  const pending2 = s.requestChange(cs2); await tick(); await approve();
  assert.equal((await pending2).status, 'applied');
  assert.equal(uploads.length, 1, 'bereits hochgeladen: wiederverwendet');
  assert.deepEqual(product.media.map(m => m.mediaId), ['m1', newMediaId, newMediaId]);

  // Rückgängig (zuletzt zuerst): Produkt wieder wie vorher, das Medium bleibt in der Medienverwaltung
  for (const id of [cs2.id, cs.id]) { const u = await undoChangeSet('upload-e2e', id); assert.ok(u?.ok, JSON.stringify(u)); }
  assert.deepEqual(product.media, [{ id: 'pm1', mediaId: 'm1', position: 0 }]); assert.equal(product.coverId, 'pm1');
  assert.ok(media.has(newMediaId)); assert.ok(!requests.some(r => r.startsWith('DELETE /api/media/')));
  s.running = false;
});

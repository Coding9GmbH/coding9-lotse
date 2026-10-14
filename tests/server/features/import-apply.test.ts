import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Shopware } from '../../../src/server/shopware';

process.env.AICB_DATA ??= fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-import-apply-'));
const { shopMediaId } = await import('../../../src/server/features/import-apply');

test('shopMediaId: image URL of the own shop uses the existing media, foreign URLs do not', async () => {
  const calls: unknown[] = [];
  const sw = {
    base: 'http://shopware:8000', publicUrl: 'http://localhost:8888',
    search: async (_e: string, c: unknown) => { calls.push(c); return { data: [{ id: 'm70c30' }] }; },
  } as unknown as Shopware;
  assert.equal(await shopMediaId(sw, 'http://localhost:8888/media/c6/34/07/1791572599/holm-2-70c30.jpg?ts=1'), 'm70c30');
  assert.deepEqual(calls[0], { limit: 1, filter: [{ type: 'equals', field: 'path', value: 'media/c6/34/07/1791572599/holm-2-70c30.jpg' }] });
  assert.equal(await shopMediaId(sw, 'http://shopware:8000/media/a/b%20c.jpg'), 'm70c30');
  assert.equal((calls[1] as { filter: { value: string }[] }).filter[0].value, 'media/a/b c.jpg');
  assert.equal(await shopMediaId(sw, 'https://lieferant.example/media/x.jpg'), null);
  assert.equal(await shopMediaId(sw, 'http://localhost:8888/bilder/x.jpg'), null);
  assert.equal(await shopMediaId(sw, 'kein link'), null);
  assert.equal(calls.length, 2);
  const failing = { ...sw, base: sw.base, publicUrl: sw.publicUrl, search: async () => { throw new Error('400 path'); } } as unknown as Shopware;
  assert.equal(await shopMediaId(failing, 'http://localhost:8888/media/x.jpg'), null);
});

test('Images on create: a broken image does not abort the product, the shop\'s own media are neither uploaded nor deleted by undo', async () => {
  const { applyImport, takeReport } = await import('../../../src/server/features/import-apply');
  const { planImport } = await import('../../../src/server/features/import-plan');
  const { setFetcher, setTrustedOrigins } = await import('../../../src/server/media');
  // SSRF protection (media.ts) resolves foreign hosts via DNS, and cdn.example doesn't exist; entered as the shop address, it is loaded directly and the HTTP status is reported
  setTrustedOrigins(async () => ['https://cdn.example']);
  const urls = ['https://cdn.example/404.jpg', 'https://shop.example/media/a/b.jpg', 'https://cdn.example/ok.jpg'];
  const fetched: string[] = [];
  setFetcher(async (u: string | URL | Request) => { fetched.push(String(u)); return String(u).includes('404') ? new Response('', { status: 404 }) : new Response(Buffer.from('bild'), { status: 200, headers: { 'content-type': 'image/jpeg' } }); });
  const t = { format: 'csv' as const, headers: ['Nr', 'Name', 'Preis', 'Bild'], rows: [['NL-5', 'Kissen', '10', urls.join(' ')]], headerRow: 1, truncated: false };
  const { cs, payload } = planImport(t, { productNumber: 'Nr', name: 'Name', priceGross: 'Preis', images: ['Bild'] }, { products: [], categories: [], manufacturers: [], groups: [], taxes: [{ id: 't19', taxRate: 19 }], deliveryTimes: [], currencyId: 'eur' }, {}, { title: 'Import', reason: 'r', fileName: 'x.csv' }, () => 'id' + Math.random().toString(16).slice(2).padEnd(30, '0'));
  const log: string[] = []; let created: Record<string, unknown> | null = null;
  const sw = {
    base: 'http://shopware:8000', publicUrl: 'https://shop.example',
    search: async (e: string) => (e === 'media' ? { data: [{ id: 'mOwn' }] } : e === 'media-default-folder' ? { data: [{ folder: { id: 'fold' } }] } : { data: [] }),
    uploadMediaBinary: async (buf: Buffer, o: { fileName: string; folderId: string | null }) => { log.push(`upload ${buf.toString()} ${o.folderId}`); return 'mNew'; },
    update: async (e: string, id: string) => { log.push(`update ${e} ${id}`); },
    get: async (e: string, id: string) => (e === 'media' ? { id, url: `http://shopware:8000/media/${id}.jpg`, fileName: 'ok', fileExtension: 'jpg' } : null),
    create: async (e: string, d: Record<string, unknown>) => { log.push(`create ${e}`); if (e === 'product') created = d; },
    salesChannels: async () => [{ id: 'sc1', domains: [{ url: 'http://x' }] }],
    req: async (m: string, p: string) => { log.push(`${m} ${p}`); return null; },
  } as unknown as Shopware;
  const res = await applyImport(sw, cs, payload, new Set(cs.items.map(i => i.id)));
  assert.deepEqual(res.results.map(r => r.ok), [true]);
  assert.deepEqual(fetched, [urls[0], urls[2]], 'the shop\'s own URL is not loaded');
  assert.ok(log.includes('upload bild fold') && log.includes('create product'));
  const media = (created as unknown as { media: { id: string; mediaId: string; position: number }[]; coverId: string }).media;
  assert.deepEqual(media.map(m => [m.mediaId, m.position]), [['mOwn', 0], ['mNew', 1]]);
  assert.equal((created as unknown as { coverId: string; media: { id: string }[] }).coverId, media[0].id);
  const rep = takeReport(cs.id)!;
  assert.equal(rep.imageErrors.length, 1); assert.match(rep.imageErrors[0], /404\.jpg.*HTTP 404/);
  assert.deepEqual(res.undo.map(u => `${u.op} ${u.entity} ${u.id}`), ['delete media mNew', `delete product ${(created as unknown as { id: string }).id}`], 'only the newly uploaded media is deleted by undo');
  setFetcher(fetch); setTrustedOrigins(async () => []);
});

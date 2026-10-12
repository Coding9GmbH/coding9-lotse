// Kontext-Auswahl der Oberfläche (Mensch) gegen einen Fake-Shopware-Server: alle Kategorien seitenweise, Produktfilter.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-shopware-ctx-'));
delete process.env.SHOP_PLATFORM;

// Über 500 Kategorien: Wurzel, 30 Hauptkategorien, darunter je 38 Unterkategorien (1171 Zeilen, drei Seiten) (Namen absichtlich unsortiert angelegt)
type Cat = { id: string; name: string; translated: { name: string }; parentId: string | null; level: number; active: boolean; type: string; cmsPage: { name: string } | null };
const cats: Cat[] = [{ id: 'c0000', name: 'Katalog', translated: { name: 'Katalog' }, parentId: null, level: 1, active: true, type: 'page', cmsPage: null }];
for (let i = 1; i <= 30; i++) {
  const main = `c${String(i).padStart(4, '0')}`;
  cats.push({ id: main, name: `Haupt ${String(31 - i).padStart(2, '0')}`, translated: { name: `Haupt ${String(31 - i).padStart(2, '0')}` }, parentId: 'c0000', level: 2, active: i % 2 === 0, type: 'page', cmsPage: i === 1 ? { name: 'Layout A' } : null });
  for (let k = 1; k <= 38; k++) cats.push({ id: `${main}-${k}`, name: `Unter ${i}-${k}`, translated: { name: `Unter ${i}-${k}` }, parentId: main, level: 3, active: true, type: k % 13 === 0 ? 'folder' : 'page', cmsPage: null });
}
assert.equal(cats.length, 1171);

const criteria: Record<string, unknown>[] = [];
const srv = http.createServer((q, r) => {
  let body = ''; q.on('data', c => { body += c; });
  q.on('end', () => {
    const send = (o: unknown) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(o)); };
    if (q.url === '/api/oauth/token') return send({ access_token: 'tok', expires_in: 600 });
    const c = JSON.parse(body || '{}') as { limit?: number; page?: number; sort?: { field: string; order: string }[] };
    criteria.push({ url: q.url, ...c });
    if (q.url === '/api/search/category') {
      const rows = [...cats];
      for (const s of [...(c.sort ?? [])].reverse()) rows.sort((a, b) => (a[s.field as 'level' | 'name'] < b[s.field as 'level' | 'name'] ? -1 : a[s.field as 'level' | 'name'] > b[s.field as 'level' | 'name'] ? 1 : 0) * (s.order === 'DESC' ? -1 : 1));
      const limit = c.limit ?? 25, page = c.page ?? 1;
      return send({ total: rows.length, data: rows.slice((page - 1) * limit, page * limit) });
    }
    if (q.url === '/api/search/product') return send({ total: 1, data: [{ id: 'p1', productNumber: 'P-1', translated: { name: 'Vase' }, cover: { media: { url: 'http://x/v.jpg' } }, cmsPage: null }] });
    r.statusCode = 404; send({ errors: [{ code: 'nf', detail: q.url }] });
  });
});
await new Promise<void>(res => srv.listen(0, '127.0.0.1', res));
after(() => srv.close());
const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

const { updateSettings } = await import('../../../../src/server/settings');
const { getPlatform, reconfigureAll } = await import('../../../../src/server/platform/index');
updateSettings({ platform: 'shopware', shopware: { url: base, user: 'admin', password: 'geheim' } });
reconfigureAll();
const shopware = getPlatform('shopware');

test('context.categories: alle Kategorien seitenweise, Reihenfolge level/name, Eltern immer vor den Kindern', async () => {
  const rows = await shopware.context.categories();
  assert.equal(rows.length, 1171);
  const pages = criteria.filter(c => c.url === '/api/search/category');
  assert.deepEqual(pages.map(c => [c.limit, c.page]), [[500, 1], [500, 2], [500, 3]]);
  assert.deepEqual(pages[0].sort, [{ field: 'level', order: 'ASC' }, { field: 'name', order: 'ASC' }]);
  assert.deepEqual(rows.slice(0, 3).map(r => r.name), ['Katalog', 'Haupt 01', 'Haupt 02']);
  const ids = new Set<string>();
  for (const r of rows) { if (r.parentId) assert.ok(ids.has(r.parentId), `Elternknoten von ${r.id} fehlt oder kommt später`); ids.add(r.id); }
  assert.deepEqual(rows.find(r => r.id === 'c0001'), { id: 'c0001', name: 'Haupt 30', parentId: 'c0000', active: false, type: 'page', cmsPage: 'Layout A' });
  assert.equal(rows.filter(r => r.type === 'folder').length, 30 * 2);
});

test('context.products: nur Hauptprodukte, Kategorie-Filter, Zeilenform', async () => {
  criteria.length = 0;
  const rows = await shopware.context.products({ term: 'Vase', categoryId: 'c0001' });
  const c = criteria.find(x => x.url === '/api/search/product')!;
  assert.equal(c.term, 'Vase'); assert.equal(c.limit, 30);
  assert.deepEqual(c.filter, [{ type: 'equals', field: 'parentId', value: null }, { type: 'equals', field: 'categoriesRo.id', value: 'c0001' }]);
  assert.deepEqual(rows, [{ id: 'p1', name: 'Vase', number: 'P-1', img: 'http://x/v.jpg', cmsPage: null }]);
  criteria.length = 0;
  await shopware.context.products({});
  const c2 = criteria.find(x => x.url === '/api/search/product')!;
  assert.equal(c2.term, undefined); assert.deepEqual(c2.filter, [{ type: 'equals', field: 'parentId', value: null }]);
});

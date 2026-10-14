import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ShopReader, SwEntity } from '../../../src/server/shopware';
import type { Table } from '../../../src/server/features/import-parse';

// loadCatalog: matching the file against the shop in chunks (read-only), parent products of variant families and parents of found variants
process.env.AICB_DATA ??= fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-import-cat-'));
const { loadCatalog } = await import('../../../src/server/features/import');

const table = (headers: string[], rows: string[][]): Table => ({ format: 'csv', headers, rows, headerRow: 1, truncated: false });
type Call = { entity: string; field?: string; n: number; assoc: string[] };

/** Fake shop: N1 (parent product), P1 (parent product with variant P1.1), N2 is a variant of pX, which is not in the file */
function shop() {
  const products: SwEntity[] = [
    { id: 'n1', productNumber: 'N1' }, { id: 'p1', productNumber: 'P1', childCount: 1, configuratorSettings: [{ optionId: 'oSand' }], children: [{ id: 'p1a', options: [{ id: 'oSand', group: { name: 'Farbe' } }] }] },
    { id: 'n2', productNumber: 'N2', parentId: 'px' }, { id: 'px', productNumber: 'PX', childCount: 1 },
  ];
  const calls: Call[] = [];
  const ro: ShopReader = {
    base: 'http://shop', get: async () => null, salesChannels: async () => [], req: async () => null,
    async search(entity, c = {}) {
      const f = (c.filter as { field: string; value: string[] }[] | undefined)?.[0];
      calls.push({ entity, field: f?.field, n: f?.value.length ?? 0, assoc: Object.keys(c.associations ?? {}) });
      if (entity !== 'product' || !f) return { data: [] };
      return { data: products.filter(p => f.value.includes(String(p[f.field]))) };
    },
  };
  return { ro, calls };
}

test('loadCatalog: numbers in chunks of 200, parent products of the file loaded with configurator, parents of found variants added', async () => {
  const rows = Array.from({ length: 450 }, (_, i) => [`N${i}`, i === 3 ? 'P1' : '']);
  const { ro, calls } = shop();
  const cat = await loadCatalog(ro, table(['Nr', 'Haupt'], rows), { productNumber: 'Nr', parentNumber: 'Haupt' }, {});
  const prod = calls.filter(c => c.entity === 'product');
  assert.deepEqual(prod.map(c => [c.field, c.n]), [['productNumber', 200], ['productNumber', 200], ['productNumber', 51], ['productNumber', 1], ['id', 1]], '450 numbers + P1 in 3 chunks, then P1 with configurator, then parent px');
  assert.ok(prod[3].assoc.includes('configuratorSettings') && prod[3].assoc.includes('children'));
  assert.deepEqual(cat.products.map(p => p.id).sort(), ['n1', 'n2', 'p1', 'px']);
  assert.equal(cat.products.find(p => p.id === 'p1')?.children?.length, 1);
  assert.deepEqual([cat.categories, cat.manufacturers, cat.groups, cat.deliveryTimes, cat.notes], [[], [], [], [], []], 'no queries for them without a category/manufacturer column');
  assert.ok(!calls.some(c => c.entity === 'category' || c.entity === 'product-manufacturer' || c.entity === 'delivery-time'));
  assert.ok(calls.some(c => c.entity === 'tax'));
});

test('loadCatalog: EAN matching only with an EAN column; slice (offset/limit) limits the checked numbers', async () => {
  const { ro, calls } = shop();
  await loadCatalog(ro, table(['Nr', 'EAN'], [['A', '4000000000001'], ['B', ''], ['C', '4000000000002']]), { productNumber: 'Nr', ean: 'EAN' }, { offset: 1, limit: 2 });
  assert.deepEqual(calls.filter(c => c.entity === 'product').map(c => [c.field, c.n]), [['productNumber', 2], ['ean', 1]]);
});

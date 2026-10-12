import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeMagento } from '../../../../src/server/platform/magento/fake';

const fake = await startFakeMagento({ products: [{ id: 1, sku: 'VASE', type_id: 'simple', attribute_set_id: 4, website_ids: [1], media: [], vals: { 0: { name: 'Vase', price: 49, status: 1, visibility: 4 } } }] });
after(() => fake.close());

const plan = { name: 'Neu', description: '<p>x</p>', price: 10, sku: 'VASE-NEU', urlKey: 'vase-neu', attributeSetId: 4, websiteIds: [1], taxClassId: '2', images: [] as string[], categoryIds: [] as string[], stock: 0, active: false, source: null as string | null };

test('Magento: Zeitlimit nach dem Anlegen lässt einen Löschschritt zurück, ein zweiter Lauf legt nicht noch eins an', async () => {
  const { MagentoClient } = await import('../../../../src/server/platform/magento/client');
  const { createProduct } = await import('../../../../src/server/platform/magento/images');
  const c = new MagentoClient({ url: fake.base, accessToken: fake.token, storeCode: 'default' });
  const orig = c.req.bind(c);
  let n = 0;
  c.req = (async (method: string, path: string, body?: unknown, o?: { store?: string; query?: string; nullOn404?: boolean }) => {
    const out = await orig(method, path, body, o);
    if (method === 'POST' && path === '/V1/products' && n++ === 0) throw new Error('Zeitlimit');
    return out;
  }) as typeof c.req;
  await assert.rejects(createProduct(c, plan), (e: { message?: string; undo?: { method?: string; path?: string }[] }) => {
    assert.match(e.message ?? '', /Zeitlimit/);
    assert.equal(e.undo?.[0]?.method, 'DELETE');
    assert.match(e.undo?.[0]?.path ?? '', /products\/VASE-NEU/);
    return true;
  });
  assert.equal(fake.products.filter(p => p.sku === 'VASE-NEU').length, 1);
  await assert.rejects(createProduct(c, plan), /SKU VASE-NEU ist schon vergeben/);
  assert.equal(fake.products.filter(p => p.sku === 'VASE-NEU').length, 1, 'kein zweites Produkt');
});

test('Magento: Rückgängig überspringt ein Feld, das weder den geschriebenen noch den vorherigen Wert hat', async () => {
  const { MagentoClient } = await import('../../../../src/server/platform/magento/client');
  const { writeScoped, undoMagento } = await import('../../../../src/server/platform/magento/write');
  const c = new MagentoClient({ url: fake.base, accessToken: fake.token, storeCode: 'default' });
  const undo = await writeScoped(c, 'product', 'VASE', 'all', { name: 'Neu' });
  assert.equal(fake.products.find(p => p.sku === 'VASE')!.vals[0].name, 'Neu');
  fake.products.find(p => p.sku === 'VASE')!.vals[0].name = 'Von Hand';
  const back = await undoMagento(c, undo);
  assert.equal(fake.products.find(p => p.sku === 'VASE')!.vals[0].name, 'Von Hand');
  assert.match(back.map(b => b.error ?? '').join(' '), /inzwischen geändert/);
});

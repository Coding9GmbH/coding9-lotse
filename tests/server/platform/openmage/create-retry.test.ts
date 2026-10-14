import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeOpenmage } from '../../../support/openmage-fake';

const fake = await startFakeOpenmage({ products: [{ id: 1, sku: 'VASE', type_id: 'simple', attribute_set_id: 4, website_ids: [1], stock: { qty: 3, is_in_stock: true, manage_stock: true }, images: [], categories: [], vals: { 0: { name: 'Vase', price: 49, status: 1, visibility: 4, url_key: 'vase' } } }] });
after(() => fake.close());

const plan = { name: 'Neu', description: '<p>x</p>', price: 10, sku: 'VASE-NEU', urlKey: 'vase-neu', attributeSetId: 4, websiteIds: [1], taxClassId: 2, images: [] as string[], categoryIds: [] as string[], stock: 0, active: false };

test('OpenMage: a timeout after creating leaves a delete step behind, a second run does not create another one', async () => {
  const { OmClient } = await import('../../../../src/server/platform/openmage/client');
  const { createProduct } = await import('../../../../src/server/platform/openmage/images');
  const c = new OmClient({ url: fake.base, token: fake.token, storeCode: 'default' });
  const orig = c.req.bind(c);
  let n = 0;
  c.req = (async (method: string, path: string, body?: unknown, o?: { store?: string; nullOn404?: boolean }) => {
    const out = await orig(method, path, body, o);
    if (method === 'POST' && path === '/v1/products' && n++ === 0) throw new Error('Zeitlimit');
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
  assert.equal(fake.products.filter(p => p.sku === 'VASE-NEU').length, 1, 'no second product');
});

test('OpenMage: undo skips a field that has neither the written nor the previous value', async () => {
  const { OmClient } = await import('../../../../src/server/platform/openmage/client');
  const { writeScoped, undoOpenmage } = await import('../../../../src/server/platform/openmage/write');
  const c = new OmClient({ url: fake.base, token: fake.token, storeCode: 'default' });
  const undo = await writeScoped(c, 'product', 'VASE', 'admin', { name: 'Neu' });
  assert.equal(fake.products.find(p => p.sku === 'VASE')!.vals[0].name, 'Neu');
  fake.products.find(p => p.sku === 'VASE')!.vals[0].name = 'Von Hand';
  const back = await undoOpenmage(c, undo);
  assert.equal(fake.products.find(p => p.sku === 'VASE')!.vals[0].name, 'Von Hand');
  assert.match(back.map(b => b.error ?? '').join(' '), /inzwischen geändert/);
});

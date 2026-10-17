// Shopify sales (Abverkauf): fixed orders query against the Admin GraphQL fake, only sums per product, read_orders required.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-shopify-sales-'));
delete process.env.SHOP_PLATFORM;

const { startFakeShopify } = await import('../../../support/shopify-fake/server');
const fake = await startFakeShopify({ port: 0 });
after(() => fake.close());
const { updateSettings } = await import('../../../../src/server/settings');
const { getPlatform, reconfigureAll } = await import('../../../../src/server/platform/index');
const { shopifySales, SALES_QUERY, NO_ORDERS, SALES_ORDERS } = await import('../../../../src/server/platform/shopify/sales');
const { shopifyClient } = await import('../../../../src/server/platform/shopify/index');

updateSettings({ platform: 'shopify', shopify: { storeDomain: fake.url, accessToken: fake.token, apiVersion: '2026-10' } });
reconfigureAll();
const shopify = getPlatform('shopify');
const VASE = 9100000000001, BECHER = 9100000000002;
type Line = { quantity: number; productId: number | null; discountedTotal: string };
let lineId = 1;
const order = (id: number, createdAt: string, lines: Line[], o: { cancelledAt?: string; test?: boolean; currencyCode?: string } = {}) =>
  ({ id, createdAt, cancelledAt: o.cancelledAt ?? null, test: o.test ?? false, currencyCode: o.currencyCode ?? 'EUR', lineItems: lines.map(l => ({ id: lineId++, ...l })) });
const range = { from: '2026-09-01', to: '2026-09-30' }, now = new Date('2026-10-05T12:00:00Z');

test('without read_orders: understandable error instead of ACCESS_DENIED', async () => {
  fake.options.accessScopes.delete('read_orders');
  await assert.rejects(shopify.sales(range), (e: Error) => e.message === NO_ORDERS);
});

test('sums per product: cancelled and test orders, items without product and orders outside the period do not count', async () => {
  fake.options.accessScopes.add('read_orders');
  fake.state.orders = [
    order(1, '2026-09-02T10:00:00Z', [{ quantity: 2, productId: VASE, discountedTotal: '98.00' }, { quantity: 1, productId: BECHER, discountedTotal: '18.00' }]),
    order(2, '2026-09-15T10:00:00Z', [{ quantity: 1, productId: VASE, discountedTotal: '44.10' }, { quantity: 1, productId: null, discountedTotal: '5.00' }]),
    order(3, '2026-09-16T10:00:00Z', [{ quantity: 5, productId: VASE, discountedTotal: '245.00' }], { cancelledAt: '2026-09-17T10:00:00Z' }),
    order(4, '2026-09-17T10:00:00Z', [{ quantity: 9, productId: BECHER, discountedTotal: '162.00' }], { test: true }),
    order(5, '2026-08-31T23:00:00Z', [{ quantity: 3, productId: BECHER, discountedTotal: '54.00' }]),
    order(6, '2026-10-01T00:30:00Z', [{ quantity: 3, productId: BECHER, discountedTotal: '54.00' }]),
  ];
  const r = await shopifySales((d, v) => shopifyClient().gql(d, v), range, { now });
  const by = Object.fromEntries(r.rows.map(x => [x.productId, x]));
  assert.deepEqual(by[String(VASE)], { productId: String(VASE), quantity: 3, revenue: 142.1, orders: 2 });
  assert.deepEqual(by[String(BECHER)], { productId: String(BECHER), quantity: 1, revenue: 18, orders: 1 });
  assert.equal(r.rows.length, 2, 'no row for the custom item without product');
  assert.deepEqual([r.orders, r.currency, r.capped, r.notes], [2, 'EUR', false, undefined]);
});

test('query asks for no customer, address, name or order number fields', () => {
  assert.doesNotMatch(SALES_QUERY, /customer|email|address|name|phone|billing|shipping/i);
});

test('paging, line items beyond the first page, cap and note for periods older than 60 days', async () => {
  fake.options.accessScopes.add('read_orders');
  const lines = Array.from({ length: 13 }, () => ({ quantity: 1, productId: VASE, discountedTotal: '1.00' }));
  fake.state.orders = [order(100, '2026-09-03T10:00:00Z', lines), ...Array.from({ length: SALES_ORDERS * 2 }, (_, i) => order(200 + i, '2026-09-04T10:00:00Z', [{ quantity: 1, productId: BECHER, discountedTotal: '2.00' }]))];
  const q = (d: string, v?: Record<string, unknown>) => shopifyClient().gql(d, v);
  const all = await shopifySales(q, range, { now });
  assert.equal(all.rows.find(x => x.productId === String(VASE))?.quantity, 13, 'all line items of a large order');
  assert.deepEqual([all.orders, all.capped], [SALES_ORDERS * 2 + 1, false]);
  const cut = await shopifySales(q, range, { pages: 1, now });
  assert.deepEqual([cut.orders, cut.capped], [SALES_ORDERS, true]);
  const old = await shopifySales(q, { from: '2026-06-01', to: '2026-09-30' }, { now });
  assert.match(old.notes?.[0] ?? '', /read_all_orders/);
  fake.state.orders = [];
});

// Magento: sales per product (PlatformAdapter.sales) against the fake: fixed GET /V1/orders with field selection,
// configurable children and cancelled orders/quantities excluded, paging with cap, missing permission → understandable error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeMagento } from '../../../support/magento-fake';

const fake = await startFakeMagento();
const { MagentoClient } = await import('../../../../src/server/platform/magento/client');
const S = await import('../../../../src/server/platform/magento/sales');
const { magento } = await import('../../../../src/server/platform/magento');
test.after(() => fake.close());

const c = new MagentoClient({ url: fake.base, accessToken: fake.token });
const R = { from: '2026-09-01', to: '2026-09-30' };
const item = (product_id: number, qty: number, total: number, more: Record<string, unknown> = {}) => ({ product_id, parent_item_id: null, qty_ordered: qty, qty_canceled: 0, base_row_total: total / 1.19, base_row_total_incl_tax: total, base_discount_amount: 0, ...more });
const order = (entity_id: number, created_at: string, items: unknown[], more: Record<string, unknown> = {}) => ({ entity_id, created_at, state: 'complete', base_currency_code: 'EUR', customer_email: 'kunde@example.com', increment_id: `0000${entity_id}`, items, ...more });

test('sums per product: top-level rows only, cancelled orders/quantities out, period limits, distinct orders', async () => {
  fake.orders = [
    order(1, '2026-09-01 00:00:00', [item(10, 2, 40), item(20, 1, 99, { product_type: 'configurable' }), item(21, 1, 0, { parent_item_id: 2 })]), // child of the configurable row is ignored
    order(2, '2026-09-15 12:00:00', [item(10, 3, 60, { qty_canceled: 1 })]), // one of three cancelled: 2 pieces, 40 €
    order(3, '2026-09-20 08:00:00', [item(10, 5, 100)], { state: 'canceled' }), // cancelled order
    order(4, '2026-08-31 23:59:59', [item(10, 7, 140)]), // before the period
    order(5, '2026-09-30 23:59:59', [item(20, 1, 99, { base_discount_amount: 9 })]), // last second counts, discount deducted
    order(6, '2026-10-01 00:00:00', [item(20, 4, 400)]), // after the period
  ];
  const n = fake.log.length;
  const rep = await S.magentoSales(c, R);
  assert.deepEqual(rep.rows.sort((a, b) => a.productId.localeCompare(b.productId)), [
    { productId: '10', quantity: 4, revenue: 80, orders: 2 },
    { productId: '20', quantity: 2, revenue: 189, orders: 2 },
  ]);
  assert.deepEqual([rep.orders, rep.currency, rep.capped], [3, 'EUR', false]);
  // the request: fixed filters and a field selection without customer, address or order number fields
  const q = decodeURIComponent(fake.log.slice(n).find(l => l.path === '/orders')!.query!);
  assert.match(q, /fields=items\[entity_id,state,base_currency_code,items\[product_id,/);
  assert.match(q, /\[field\]=created_at&.*\[value\]=2026-09-01 00:00:00&.*\[condition_type\]=gteq/);
  assert.match(q, /\[value\]=2026-09-30 23:59:59&.*\[condition_type\]=lteq/);
  assert.match(q, /\[field\]=state&.*\[value\]=canceled&.*\[condition_type\]=neq/);
  assert.doesNotMatch(q, /customer|email|address|firstname|lastname|increment_id|telephone|payment/i);
  assert.equal(fake.log.slice(n).find(l => l.path === '/orders')!.store, 'all');
});

test('mixed base currencies: currency null with a note', async () => {
  fake.orders = [order(1, '2026-09-02 10:00:00', [item(10, 1, 10)]), order(2, '2026-09-03 10:00:00', [item(10, 1, 10)], { base_currency_code: 'CHF' })];
  const rep = await S.magentoSales(c, R);
  assert.equal(rep.currency, null);
  assert.match(rep.notes?.[0] ?? '', /mehreren Basiswährungen/);
});

test('paging over all pages, cap after SALES_PAGES pages', async () => {
  fake.orders = Array.from({ length: 250 }, (_, i) => order(i + 1, '2026-09-10 10:00:00', [item(10, 1, 1)]));
  let rep = await S.magentoSales(c, R);
  assert.deepEqual([rep.rows[0].quantity, rep.orders, rep.capped], [250, 250, false]);
  fake.orders = Array.from({ length: S.SALES_PAGE * S.SALES_PAGES + 1 }, (_, i) => order(i + 1, '2026-09-10 10:00:00', [item(10, 1, 1)]));
  const n = fake.log.length;
  rep = await S.magentoSales(c, R);
  assert.equal(rep.capped, true);
  assert.equal(rep.orders, S.SALES_PAGE * S.SALES_PAGES);
  assert.equal(fake.log.slice(n).filter(l => l.path === '/orders').length, S.SALES_PAGES);
});

test('integration without access to sales: German error, no data', async () => {
  fake.ordersDenied = true;
  await assert.rejects(S.magentoSales(c, R), /Magento erlaubt Lotse keine Bestellungen zu lesen: .*Vertrieb → Bestellungen/);
  fake.ordersDenied = false;
});

test('adapter offers sales; the AI read client keeps /V1/orders blocked', async () => {
  assert.equal(typeof magento.sales, 'function');
  const { createMagentoGuard } = await import('../../../../src/server/platform/magento/reader');
  assert.throws(() => createMagentoGuard().check('GET', '/V1/orders'), /ZUGRIFF VERWEIGERT/);
});

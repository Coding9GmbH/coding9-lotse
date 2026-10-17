import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NeutralProduct } from '../../../src/lib/custom-checks';
import type { SalesRange, SalesReport } from '../../../src/server/platform/types';

// Sales without personal data: pure evaluation, the tool and checks behind the AI access switch, the Shopware query
process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-sales-'));
const L = await import('../../../src/server/features/sales-logic');
const F = await import('../../../src/server/features/sales');
const { getPlatform } = await import('../../../src/server/platform');
const { updateSettings } = await import('../../../src/server/settings');
const { listChecks } = await import('../../../src/server/checks');
const { accessList } = await import('../../../src/server/db');
const { shopwareSales, salesCriteria, SALES_PAGE } = await import('../../../src/server/platform/shopware/sales');

const prod = (id: string, o: Partial<NeutralProduct> = {}): NeutralProduct => ({ id, label: `P${id}`, name: `Produkt ${id}`, description: '<p>' + 'Wort '.repeat(150) + '</p>', metaTitle: 'T', metaDescription: 'D', price: 10, listPrice: null, stock: 5, hasImage: true, ...o });
const rep = (rows: [string, number, number, number][]): SalesReport => ({ rows: rows.map(([productId, quantity, revenue, orders]) => ({ productId, quantity, revenue, orders })), orders: 9, currency: 'EUR', capped: false });

test('period: last full days up to yesterday (UTC), clamped to 1 to 365', () => {
  const now = new Date('2026-10-17T08:00:00Z');
  assert.deepEqual(L.salesRange(30, now), { from: '2026-09-17', to: '2026-10-16', days: 30 });
  assert.deepEqual(L.salesRange(1, now), { from: '2026-10-16', to: '2026-10-16', days: 1 });
  assert.equal(L.salesRange(5000, now).days, 365);
  assert.equal(L.salesRange(0, now).days, 30, 'invalid → default');
});

test('top sellers, slow movers and top sellers with weak content', () => {
  const products = [prod('a'), prod('b', { description: '<p>kurz</p>', metaDescription: '' }), prod('c', { stock: 40, price: 20 }), prod('d', { stock: 0 }), prod('e', { stock: 3, price: null }), prod('f', { hasImage: false })];
  const r = rep([['a', 10, 500, 8], ['b', 30, 300, 3], ['a', 1, 50, 1], ['f', 2, 100, 2], ['x', 1, 5, 1]]);
  const merged = { ...r, rows: L.mergeRows(r.rows) };
  assert.deepEqual(merged.rows.find(x => x.productId === 'a'), { productId: 'a', quantity: 11, revenue: 550, orders: 9 });
  const top = L.topSellers(merged, products);
  assert.deepEqual(top.map(t => t.productId), ['a', 'b', 'f', 'x']);
  assert.equal(top[0].share, 0.576); assert.equal(top[3].product, null, 'sold but not active: no product data');
  assert.deepEqual(L.topSellers(merged, products, { sortBy: 'quantity', top: 1 }).map(t => t.productId), ['b']);
  const slow = L.slowMovers(merged, products);
  assert.deepEqual(slow.items.map(s => [s.product.id, s.stockValue]), [['c', 800], ['e', null]], 'stock without sale, most tied-up capital first; no stock = not a slow mover');
  const weak = L.weakTopSellers(merged, products);
  assert.deepEqual(weak.items.map(w => [w.productId, w.problems]), [['b', ['thin-description', 'no-meta-description']], ['f', ['no-image']]]);
});

test('tool and checks: off by default, on → sums from the adapter, cached, access logged', async () => {
  const sw = getPlatform('shopware'), orig = { sales: sw.sales, scan: sw.scanProducts };
  const calls: SalesRange[] = [];
  sw.sales = async r => { calls.push(r); return rep([['a', 10, 500, 8], ['b', 30, 300, 3]]); };
  sw.scanProducts = async () => ({ rows: [prod('a'), prod('b', { description: '', metaTitle: '' }), prod('c')], total: 3, capped: false });
  try {
    const session = { id: 'chat-s', platform: 'shopware', reader: {}, lookup: {} } as never;
    const call = async (args: Record<string, unknown>) => { const t = F.sales.tools(session)[0]; return await t.handler(args, {}) as { content: { text: string }[]; isError?: boolean }; };
    const off = await call({});
    assert.equal(off.isError, true); assert.match(off.content[0].text, /Abverkaufsdaten ist ausgeschaltet.*KI-Zugriff → Abverkauf/);
    assert.equal(calls.length, 0, 'switch off: the adapter is not asked');

    updateSettings({ scopes: { sales: true } });
    F.clearSalesCache();
    const top = JSON.parse((await call({ days: 30 })).content[0].text);
    assert.deepEqual(top.items.map((i: { productId: string }) => i.productId), ['a', 'b']);
    assert.deepEqual(top.totals, { revenue: 800, quantity: 40 });
    assert.equal(top.items[0].name, 'Produkt a'); assert.equal(top.currency, 'EUR');
    assert.ok(!/kunde|customer|email|adress/i.test(JSON.stringify(top.items)), 'no personal data in the result');
    const weak = JSON.parse((await call({ view: 'weak-content' })).content[0].text);
    assert.deepEqual(weak.items.map((i: { productId: string }) => i.productId), ['b']);
    assert.equal(calls.length, 1, 'same period: from the cache');
    const slow = JSON.parse((await call({ view: 'slow' })).content[0].text);
    assert.deepEqual(slow.items.map((i: { productId: string }) => i.productId), ['c']);
    assert.match(slow.period, /90 Tage/);
    assert.ok(accessList().some(a => a.op === 'sales' && a.entity === 'sales'), 'reading is logged');

    const checks = listChecks('shopware').filter(c => c.area === 'Abverkauf');
    assert.deepEqual(checks.map(c => c.id).sort(), ['sales.slow-movers', 'sales.weak-top-sellers']);
    assert.ok(checks.every(c => c.scopes?.includes('sales') && c.platforms === 'all'));
    const ctx = { platform: 'shopware' as const, reader: {}, lookup: {} as never };
    const w = await checks.find(c => c.id === 'sales.weak-top-sellers')!.run({} as never, ctx) as { count: number; sample: { id: string }[] };
    assert.equal(w.count, 1); assert.equal(w.sample[0].id, 'b');
    updateSettings({ scopes: { sales: false } });
    assert.equal(await checks[0].run({} as never, ctx), null, 'switch off: no findings');
  } finally { sw.sales = orig.sales; sw.scanProducts = orig.scan; F.clearSalesCache(); }
});

test('Shopware: fixed line-item query, variants added to their parent, cancelled orders filtered in the query', async () => {
  const seen: { entity: string; c: Record<string, unknown> }[] = [];
  const items = [
    { productId: 'v1', quantity: 2, totalPrice: 40, orderId: 'o1', order: { currencyId: 'eur' } },
    { productId: 'v2', quantity: 1, totalPrice: 20, orderId: 'o2', order: { currencyId: 'eur' } },
    { productId: 'p2', quantity: 3, totalPrice: 15.5, orderId: 'o1', order: { currencyId: 'eur' } },
  ];
  const sw = { search: async (entity: string, c: Record<string, unknown> = {}) => {
    seen.push({ entity, c });
    if (entity === 'order-line-item') return { data: c.page === 1 ? items : [], total: 0 };
    if (entity === 'product') return { data: [{ id: 'v1', parentId: 'p1' }, { id: 'v2', parentId: 'p1' }, { id: 'p2', parentId: null }], total: 3 };
    if (entity === 'currency') return { data: [{ isoCode: 'EUR' }], total: 1 };
    return { data: [], total: 0 };
  } } as never;
  const r = await shopwareSales(sw, { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(r.rows.sort((a, b) => a.productId.localeCompare(b.productId)), [{ productId: 'p1', quantity: 3, revenue: 60, orders: 2 }, { productId: 'p2', quantity: 3, revenue: 15.5, orders: 1 }]);
  assert.deepEqual([r.orders, r.currency, r.capped], [2, 'EUR', false]);
  assert.equal(r.notes, undefined, 'gross orders only: no note');
  items[1].order = { currencyId: 'eur', taxStatus: 'net' } as never;
  assert.match((await shopwareSales(sw, { from: '2026-09-01', to: '2026-09-30' })).notes?.[0] ?? '', /Nettopreise/, 'net orders (B2B): mixed sums are named');
  const q = JSON.stringify(salesCriteria({ from: '2026-09-01', to: '2026-09-30' }, 1));
  assert.match(q, /"order.orderDateTime".*"gte":"2026-09-01T00:00:00.000\+00:00".*"lte":"2026-09-30T23:59:59.999\+00:00"/);
  assert.match(q, /cancelled/);
  assert.doesNotMatch(q, /customer|email|address|orderNumber|firstName|lastName/i, 'only product ID, quantity, price, order ID and currency');
  // cap: full pages up to SALES_PAGES → capped
  let pages = 0;
  const big = { search: async (entity: string) => entity === 'order-line-item' ? (pages++, { data: Array.from({ length: SALES_PAGE }, () => ({ productId: 'p', quantity: 1, totalPrice: 1, orderId: 'o', order: { currencyId: 'eur' } })), total: 0 }) : entity === 'currency' ? { data: [{ isoCode: 'EUR' }], total: 1 } : { data: [], total: 0 } } as never;
  assert.equal((await shopwareSales(big, { from: '2026-09-01', to: '2026-09-30' })).capped, true);
  assert.equal(pages, 40);
});

test('cache per connected shop and a product scan that expires (review fixes)', async () => {
  const sw = getPlatform('shopware'), orig = { sales: sw.sales, scan: sw.scanProducts };
  let calls = 0, scans = 0;
  sw.sales = async () => { calls++; return rep([['a', 1, 10, 1]]); };
  sw.scanProducts = async () => { scans++; return { rows: [prod('a')], total: 1, capped: false }; };
  try {
    F.clearSalesCache();
    updateSettings({ platform: 'shopware', shopware: { url: 'https://shop-a.test' } });
    await F.salesReport('shopware'); await F.salesReport('shopware');
    assert.equal(calls, 1, 'same shop: from the cache');
    updateSettings({ shopware: { url: 'https://shop-b.test' } });
    await F.salesReport('shopware');
    assert.equal(calls, 2, 'another shop on the same platform: read again, never the other shop\'s sums');
    const reader = {}, t0 = Date.now();
    await F.scanOf('shopware', reader, t0); await F.scanOf('shopware', reader, t0 + 60_000);
    assert.equal(scans, 1, 'within 5 minutes: same scan');
    await F.scanOf('shopware', reader, t0 + 6 * 60_000);
    assert.equal(scans, 2, 'later: fresh scan (texts improved in the same chat count)');
    sw.scanProducts = async () => { scans++; throw new Error('down'); };
    const r2 = {};
    await assert.rejects(F.scanOf('shopware', r2, t0));
    sw.scanProducts = async () => { scans++; return { rows: [], total: 0, capped: false }; };
    assert.deepEqual((await F.scanOf('shopware', r2, t0 + 1)).rows, [], 'a failed scan is not cached');
  } finally { sw.sales = orig.sales; sw.scanProducts = orig.scan; F.clearSalesCache(); }
});

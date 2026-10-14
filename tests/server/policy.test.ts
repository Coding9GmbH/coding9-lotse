import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGuard, DEFAULT_SCOPES, type AccessEvent } from '../../src/server/policy';
import { ReadOnlyShopware, type ShopReader } from '../../src/server/shopware';

test('Guard: customer/order entities are blocked', () => {
  const g = createGuard();
  for (const e of ['customer', 'order', 'order-line-item', 'user', 'integration', 'newsletter-recipient'])
    assert.throws(() => g.checkSearch(e, {}), /ZUGRIFF VERWEIGERT/, e);
  assert.doesNotThrow(() => g.checkSearch('product', {}));
});

test('Guard: non-allowed associations are rejected (also nested)', () => {
  const g = createGuard();
  assert.throws(() => g.checkSearch('product', { associations: { orderLineItems: {} } }), /Beziehung „product.orderLineItems“/);
  assert.throws(() => g.checkSearch('product', { associations: { cover: { associations: { customer: {} } } } }), /ZUGRIFF VERWEIGERT/);
  assert.doesNotThrow(() => g.checkSearch('product', { associations: { cover: { associations: { media: {} } }, manufacturer: {} } }));
});

test('Guard: filters/sorting with sensitive references are blocked', () => {
  const g = createGuard();
  assert.throws(() => g.checkSearch('product', { filter: [{ type: 'equals', field: 'orderLineItems.order.orderCustomer.email', value: 'x' }] }), /Filter\/Sortierung/);
  assert.throws(() => g.checkSearch('product', { sort: [{ field: 'customer.lastName' }] }), /Filter\/Sortierung/);
  assert.doesNotThrow(() => g.checkSearch('category', { sort: [{ field: 'level', order: 'ASC' }] }));
});

test('Guard: query (score queries), post-filter and grouping are checked too; unknown search parameters are blocked', () => {
  const g = createGuard();
  assert.throws(() => g.checkSearch('product', { query: [{ score: 1, query: { type: 'contains', field: 'orderLineItems.order.orderCustomer.email', value: 'a@' } }] }), /Filter\/Sortierung/);
  assert.throws(() => g.checkSearch('product', { 'post-filter': [{ type: 'equals', field: 'customer.id', value: 'x' }] }), /Filter\/Sortierung/);
  assert.throws(() => g.checkSearch('product', { grouping: ['orderCustomer.email'] }), /Filter\/Sortierung/);
  assert.throws(() => g.checkSearch('product', { 'grouping-fields': ['name'] }), /Suchparameter grouping-fields sind nicht erlaubt/);
  assert.throws(() => g.checkSearch('product', { title: 'x' }), /Suchparameter title/);
  assert.doesNotThrow(() => g.checkSearch('product', { ids: ['a'], limit: 5, page: 1, term: 'vase', 'total-count-mode': 1, includes: { product: ['id', 'name'] }, query: [{ score: 1, query: { type: 'contains', field: 'name', value: 'Vase' } }], 'post-filter': [{ type: 'equals', field: 'active', value: true }], grouping: ['productNumber'], sort: [{ field: 'name', order: 'ASC' }] }));
});

test('Guard: disabled scopes are denied', () => {
  const g = createGuard({ getScopes: () => ({ ...DEFAULT_SCOPES, media: false }) });
  assert.throws(() => g.checkSearch('media', {}), /nicht freigegeben/);
  assert.throws(() => g.checkSearch('product', { associations: { cover: { associations: { media: {} } } } }), /nicht freigegeben/);
});

test('Guard: only allowed direct endpoints', () => {
  const g = createGuard();
  assert.doesNotThrow(() => g.checkGet('GET', '/_info/version'));
  assert.throws(() => g.checkGet('POST', '/_info/version'), /nicht erlaubt/);
  assert.throws(() => g.checkGet('GET', '/user'), /nicht erlaubt/);
});

test('ReadOnlyShopware: removes sensitive fields and logs', async () => {
  const log: AccessEvent[] = [];
  const fake: ShopReader = {
    base: 'http://shop',
    search: async () => ({ data: [{ id: '1', name: 'A', email: 'a@b.de', nested: { password: 'x', firstName: 'Max', apiKey: 'k', ok: 1 } }] }),
    get: async () => null, salesChannels: async () => [], req: async () => null,
  };
  const ro = new ReadOnlyShopware(fake, createGuard({ onAccess: a => log.push(a) }));
  const r = await ro.search('product', {});
  assert.deepEqual(r.data[0], { id: '1', name: 'A', nested: { ok: 1 } });
  assert.equal(log.at(-1)?.scrubbed, 4);
  assert.equal(log.at(-1)?.n, 1);
  await assert.rejects(ro.search('customer', {}), /ZUGRIFF VERWEIGERT/);
  assert.equal(log.at(-1)?.op, 'deny');
  assert.throws(() => ro.req('PATCH', '/product/1', {}), /nicht erlaubt/);
  assert.equal('create' in ro, false);
  assert.equal('update' in ro, false);
});

test('ReadOnlyShopware: reading in a language only with a valid ID, allow-list check stays', async () => {
  const seen: unknown[] = [];
  const fake: ShopReader = { base: 'http://shop', search: async (_e, _c, o) => { seen.push(o); return { data: [] }; }, get: async (_e, _i, _c, o) => { seen.push(o); return null; }, salesChannels: async () => [], req: async () => null };
  const ro = new ReadOnlyShopware(fake, createGuard());
  const de = '01994d2a85a070a79eeed809a05da65a';
  await ro.search('product', {}, { languageId: de });
  await ro.get('category', 'x', {}, { languageId: de });
  assert.deepEqual(seen, [{ languageId: de }, { languageId: de }]);
  await assert.rejects(ro.search('product', {}, { languageId: 'de\r\nx-evil: 1' }), /Ungültige Sprach-ID/);
  await assert.rejects(ro.search('customer', {}, { languageId: de }), /ZUGRIFF VERWEIGERT/);
  await assert.rejects(ro.search('language', { associations: { salesChannelDomains: {} } }), /Beziehung „language.salesChannelDomains“/);
  assert.equal(seen.length, 2);
});

test('ReadOnlyShopware: basic information settings only scrubbed and only with scope "Shop-Grunddaten"', async () => {
  const fake: ShopReader = {
    base: 'http://shop', search: async () => ({ data: [] }), get: async () => null, salesChannels: async () => [],
    req: async () => ({ 'core.basicInformation.email': 'shop@x.de', 'core.basicInformation.imprintPage': 'p1', 'core.basicInformation.activeCaptchasV2': { g: { config: { secretKey: 's', siteKey: 'k' } } } }),
  };
  const r = await new ReadOnlyShopware(fake, createGuard()).req('GET', '/_action/system-config?domain=core.basicInformation');
  assert.deepEqual(r, { 'core.basicInformation.imprintPage': 'p1', 'core.basicInformation.activeCaptchasV2': { g: { config: { siteKey: 'k' } } } });
  const off = new ReadOnlyShopware(fake, createGuard({ getScopes: () => ({ ...DEFAULT_SCOPES, shop: false }) }));
  assert.throws(() => off.req('GET', '/_action/system-config?domain=core.basicInformation'), /nicht freigegeben/);
  assert.throws(() => new ReadOnlyShopware(fake, createGuard()).req('GET', '/_action/system-config?domain=core.mailerSettings'), /nicht erlaubt/);
});

test('Guard: promotions readable, order/customer references not', () => {
  const g = createGuard();
  assert.doesNotThrow(() => g.checkSearch('promotion', { associations: { salesChannels: {}, discounts: { associations: { discountRules: { associations: { conditions: {} } } } } } }));
  assert.throws(() => g.checkSearch('promotion', { associations: { orderRules: {} } }), /ZUGRIFF VERWEIGERT/);
  assert.throws(() => g.checkSearch('promotion', { associations: { personaCustomers: {} } }), /ZUGRIFF VERWEIGERT/);
  assert.throws(() => g.checkSearch('promotion', { filter: [{ type: 'equals', field: 'orderLineItems.orderId', value: 'x' }] }), /Filter\/Sortierung/);
});

test('ReadOnlyShopware: redeemers and customer values in rules are removed', async () => {
  const fake: ShopReader = {
    base: 'http://shop',
    search: async () => ({ data: [{ id: 'p', orderCount: 3, ordersPerCustomerCount: { c1: 2 }, individualCodes: [{ code: 'A', payload: { orderId: 'o', customerId: 'c', customerName: 'Max M.' } }],
      conditions: [{ ruleId: 'r', type: 'customerCustomerGroup', value: { customerGroupIds: ['g'] } }, { ruleId: 'r', type: 'customerEmail', value: { email: 'a@b.de' } }, { ruleId: 'r', type: 'cartLineItemInCategory', value: { categoryIds: ['c'] } }] }] }),
    get: async () => null, salesChannels: async () => [], req: async () => null,
  };
  const r = await new ReadOnlyShopware(fake, createGuard()).search('promotion', {});
  assert.deepEqual(r.data[0], { id: 'p', orderCount: 3, individualCodes: [{ code: 'A', payload: {} }],
    conditions: [{ ruleId: 'r', type: 'customerCustomerGroup' }, { ruleId: 'r', type: 'customerEmail' }, { ruleId: 'r', type: 'cartLineItemInCategory', value: { categoryIds: ['c'] } }] });
});

test('scrubSensitive/isSensitiveKey: shared building blocks for other platforms', async () => {
  const { scrubSensitive, isSensitiveKey, DENIED_TERMS } = await import('../../src/server/policy');
  const d = { title: 'Vase', vendor: 'Holm', customer: { email: 'a@b.de', firstName: 'A' }, variants: [{ sku: 'X', accessToken: 't' }] };
  assert.equal(scrubSensitive(d), 3);
  assert.deepEqual(d, { title: 'Vase', vendor: 'Holm', customer: {}, variants: [{ sku: 'X' }] });
  assert.ok(isSensitiveKey('password') && !isSensitiveKey('title'));
  for (const t of ['customers', 'orders', 'draftOrders', 'staffMember', 'paymentTerms', 'giftCard.email']) assert.ok(DENIED_TERMS.test(t) || isSensitiveKey(t.split('.').pop()!), t);
});

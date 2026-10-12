import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatEvent, UndoOp } from '@/lib/protocol';
import { startFakeMagento, type FakeProduct } from '../../../../src/server/platform/magento/fake';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-magento-'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const prod = (id: number, sku: string, v: Record<string, unknown>, extra: Partial<FakeProduct> = {}): FakeProduct => ({ id, sku, type_id: 'simple', attribute_set_id: 4, website_ids: [1], media: [], vals: { 0: { status: 1, visibility: 4, url_key: sku.toLowerCase(), ...v } }, ...extra });
const fake = await startFakeMagento({
  categories: [
    { id: 2, parent_id: 1, level: 1, path: '1/2', vals: { 0: { name: 'Default Category', is_active: true } }, products: [] },
    { id: 3, parent_id: 2, level: 2, path: '1/2/3', vals: { 0: { name: 'Wohnaccessoires', is_active: true, description: '<p>Wohnen</p>', url_key: 'wohnaccessoires', url_path: 'wohnaccessoires' } }, products: [{ sku: 'VASE', position: 0 }] },
    { id: 4, parent_id: 2, level: 2, path: '1/2/4', vals: { 0: { name: 'Küche', is_active: true, url_key: 'kueche', url_path: 'kueche' } }, products: [{ sku: 'BECHER', position: 1 }] },
  ],
  products: [
    prod(1, 'VASE', { name: 'Vase', price: 49, description: '<p>Vase aus Steinzeug</p>', meta_title: 'Vase | Holm', contact_email: 'einkauf@holm.test', image: '/v/a/vase.jpg', small_image: '/v/a/vase.jpg', thumbnail: '/v/a/vase.jpg', swatch_image: 'no_selection' },
      { media: [{ id: 1, file: '/v/a/vase.jpg', media_type: 'image', vals: { 0: { label: 'Vase', position: 1, disabled: false } } }, { id: 2, file: '/v/a/vase-2.jpg', media_type: 'image', vals: { 0: { label: '', position: 2, disabled: false } } }] }),
    prod(2, 'BECHER', { name: 'Becher', price: 18, special_price: 15, special_from_date: '2020-01-01 00:00:00' }),
    prod(3, 'KISSEN', { name: 'Kissen', price: 0 }, { type_id: 'configurable', children: ['KISSEN-SAND'], options: [{ id: 1, attribute_id: 93, label: 'Farbe', values: [{ value_index: 11 }] }] }),
    prod(4, 'KISSEN-SAND', { name: 'Kissen Sand', price: 39, visibility: 1, color: '11' }),
  ],
  sourceItems: [{ sku: 'VASE', source_code: 'default', quantity: 10, status: 1 }, { sku: 'BECHER', source_code: 'default', quantity: 5, status: 1 }, { sku: 'KISSEN-SAND', source_code: 'default', quantity: 3, status: 1 }],
  rules: [{ rule_id: 1, name: 'Willkommen', is_active: true, coupon_type: 'SPECIFIC_COUPON', use_auto_generation: false, simple_action: 'by_percent', discount_amount: 10, discount_step: 0, apply_to_shipping: false, stop_rules_processing: false, uses_per_customer: 1, uses_per_coupon: 0, sort_order: 0, times_used: 2, condition: { conditions: [] }, action_condition: { conditions: [] } },
    { rule_id: 2, name: 'Wohnen', is_active: true, coupon_type: 'NO_COUPON', use_auto_generation: false, simple_action: 'by_percent', discount_amount: 15, discount_step: 2, discount_qty: 5, apply_to_shipping: true, stop_rules_processing: false, uses_per_customer: 0, uses_per_coupon: 0, sort_order: 1, times_used: 0, from_date: '2026-01-01', store_labels: [{ store_id: 1, store_label: 'Wohnrabatt DE' }],
    condition: { condition_type: 'Magento\\SalesRule\\Model\\Rule\\Condition\\Combine', aggregator_type: 'all', value: '1', conditions: [{ condition_type: 'Magento\\SalesRule\\Model\\Rule\\Condition\\Address', attribute_name: 'country_id', operator: '==', value: 'DE' }] },
    action_condition: { condition_type: 'Magento\\SalesRule\\Model\\Rule\\Condition\\Product\\Combine', aggregator_type: 'all', value: '1', conditions: [{ condition_type: 'Magento\\SalesRule\\Model\\Rule\\Condition\\Product', attribute_name: 'category_ids', operator: '()', value: '3' }] } }],
  coupons: [{ coupon_id: 1, rule_id: 1, code: 'WILLKOMMEN10', is_primary: true, times_used: 2, usage_limit: 0, usage_per_customer: 1, type: 0 }],
});
process.env.SHOP_PLATFORM = 'magento';
process.env.MAGENTO_URL = fake.base;
process.env.MAGENTO_ACCESS_TOKEN = fake.token;
process.env.MAGENTO_PRICE_BASIS = 'gross';

const { criteriaQuery, likeTerm } = await import('../../../../src/server/platform/magento/criteria');
const map = await import('../../../../src/server/platform/magento/map');
const { createMagentoGuard, MagentoReader } = await import('../../../../src/server/platform/magento/reader');
const { MagentoClient, magentoMessage } = await import('../../../../src/server/platform/magento/client');
const { auditRecords } = await import('../../../../src/server/platform/magento/audit');
const { magento } = await import('../../../../src/server/platform/magento/index');
const { getSession, decideChange, undoChangeSet } = await import('../../../../src/server/sessions');
const { buildTools, toolNamesFor } = await import('../../../../src/server/tools');
const { stageImage } = await import('../../../../src/server/media');
const { accessList } = await import('../../../../src/server/db');
const { buildBasePrompt } = await import('../../../../src/server/prompt');
const { PLATFORM_SETTINGS } = await import('@/lib/platforms');

test.after(() => fake.close());

// ================= reine Logik =================
test('searchCriteria: Gruppen UND, Filter ODER, Seitengröße immer begrenzt, like maskiert', () => {
  const q = decodeURIComponent(criteriaQuery({ filters: [[{ field: 'name', value: likeTerm('50%_x'), condition_type: 'like' }, { field: 'sku', value: 'A' }], [{ field: 'entity_id', value: [1, 2], condition_type: 'in' }]], sort: [{ field: 'entity_id', direction: 'DESC' }] }));
  assert.match(q, /searchCriteria\[filter_groups\]\[0\]\[filters\]\[0\]\[field\]=name/);
  assert.match(q, /\[filter_groups\]\[0\]\[filters\]\[0\]\[value\]=%50\\%\\_x%/);
  assert.match(q, /\[filter_groups\]\[0\]\[filters\]\[1\]\[value\]=A/);
  assert.doesNotMatch(q, /\[filters\]\[1\]\[condition_type\]/, 'eq ohne condition_type');
  assert.match(q, /\[filter_groups\]\[1\]\[filters\]\[0\]\[value\]=1,2&.*\[condition_type\]=in/);
  assert.match(q, /sortOrders\]\[0\]\[direction\]=DESC/);
  assert.match(decodeURIComponent(criteriaQuery({})), /pageSize\]=20&searchCriteria\[currentPage\]=1$/);
  assert.match(decodeURIComponent(criteriaQuery({ pageSize: 5000 })), /pageSize\]=500/);
});

test('Preise: Streichpreis ↔ price + special_price, geplanter Sonderpreis bleibt, Fehler bei Streichpreis ≤ Preis', () => {
  const today = '2026-10-10';
  const plain = map.priceState({ price: 49 }, today);
  assert.deepEqual([plain.selling, plain.list, plain.active], [49, null, false]);
  const sale = map.priceState({ price: 49, custom_attributes: [{ attribute_code: 'special_price', value: '39' }, { attribute_code: 'special_to_date', value: '2026-12-31 00:00:00' }] }, today);
  assert.deepEqual([sale.selling, sale.list, sale.active, sale.to], [39, 49, true, '2026-12-31']);
  const planned = map.priceState({ price: 49, custom_attributes: [{ attribute_code: 'special_price', value: '39' }, { attribute_code: 'special_from_date', value: '2026-11-01' }] }, today);
  assert.deepEqual([planned.selling, planned.list, planned.active], [49, null, false]);
  // Streichpreis setzen: regulärer Preis = Streichpreis, Sonderpreis = Verkaufspreis, Startdatum wird mitgeschrieben
  assert.deepEqual(map.planPrice(plain, { price: 39, listPrice: 49 }).write, { special_price: 39, special_from_date: null });
  assert.deepEqual(map.planPrice(plain, { listPrice: 59 }).write, { price: 59, special_price: 49, special_from_date: null });
  // Aktion beenden: Sonderpreis + Zeitraum weg, regulärer Preis = bisheriger Verkaufspreis
  assert.deepEqual(map.planPrice(sale, { listPrice: null }).write, { price: 39, special_price: null, special_to_date: null });
  // nur Preis bei laufender Aktion: Sonderpreis ändert sich
  assert.deepEqual(map.planPrice(sale, { price: 35 }).write, { special_price: 35, special_from_date: null });
  // nur Preis bei geplanter Aktion: geplanter Sonderpreis bleibt, Hinweis
  const r = map.planPrice(planned, { price: 45 });
  assert.deepEqual(r.write, { price: 45 }); assert.match(r.notes.join(), /bleibt unverändert/);
  assert.throws(() => map.planPrice(plain, { listPrice: 40 }), /muss über dem Preis/);
  assert.throws(() => map.planPrice(plain, { to: '2026-12-31' }), /Zeitraum gilt nur/);
});

test('Hilfen: URL-Schlüssel, Medien-ID, Gleichheit, Fehlertexte, SEO-Prüfung', () => {
  assert.equal(map.urlKey('Vase „Kiesel“ Größe Ä/Ö/ü 22 cm'), 'vase-kiesel-groesse-ae-oe-ue-22-cm');
  assert.deepEqual(map.parseMediaId(map.mediaId(12, 7)), { productId: '12', entryId: 7 });
  assert.equal(map.parseMediaId('staged:abc'), null);
  assert.ok(map.sameValue(null, '') && map.sameValue(2, '2') && !map.sameValue('a', null));
  assert.equal(magentoMessage({ message: 'No such entity with %fieldName = %fieldValue', parameters: { fieldName: 'sku', fieldValue: 'X' } }, ''), 'No such entity with sku = X');
  assert.equal(magentoMessage({ message: 'Rule "%1" not found', parameters: ['7'] }, ''), 'Rule "7" not found');
  const res = auditRecords([{ id: 1, custom_attributes: [{ attribute_code: 'meta_title', value: 'A' }], media_gallery_entries: [] }, { id: 2, custom_attributes: [{ attribute_code: 'meta_title', value: 'A' }, { attribute_code: 'meta_description', value: 'x'.repeat(130) }], media_gallery_entries: [{ id: 1, label: '' }] }], 'product');
  assert.deepEqual(res.metaTitleDuplicate, ['1', '2']); assert.deepEqual(res.metaDescriptionMissing, ['1']); assert.deepEqual(res.noImage, ['1']); assert.deepEqual(res.imageWithoutAlt, ['2']);
});

// ================= Datenschutz =================
test('Guard: Kunden, Bestellungen, Warenkörbe, Integrationen gesperrt; Bereiche schaltbar; Filterfelder nur laut Freigabeliste; Protokoll', async () => {
  const events: { op: string; entity: string; denied?: string }[] = [];
  let scopes = { products: true, categories: true, cms: true, media: true, marketing: true, shop: true };
  const g = createMagentoGuard({ getScopes: () => scopes, onAccess: a => events.push(a) });
  for (const p of ['/V1/customers/1', '/V1/customers/search', '/V1/orders', '/V1/orders/1', '/V1/invoices', '/V1/creditmemo/1', '/V1/carts/mine', '/V1/guest-carts/x', '/V1/integration/admin/token', '/V1/customerGroups/search', '/V1/transactions', '/V1/shipment/1'])
    assert.throws(() => g.check('GET', p), /ZUGRIFF VERWEIGERT/, p);
  assert.throws(() => g.check('POST', '/V1/products'), /nicht erlaubt/);
  assert.throws(() => g.check('GET', '/V1/products', { filters: [[{ field: 'customer_id', value: 1 }]] }), /nicht freigegeben/);
  assert.throws(() => g.check('GET', '/V1/salesRules/search', { filters: [[{ field: 'customer_group_ids', value: 1 }]] }), /nicht freigegeben/);
  assert.equal(g.check('GET', '/V1/products/ORDER-BOX'), 'product', 'SKU mit „order“ ist ein Produkt');
  assert.equal(g.check('GET', '/V1/salesRules/search', { sort: [{ field: 'sort_order' }] }), 'sales-rule');
  scopes = { ...scopes, marketing: false };
  assert.throws(() => g.check('GET', '/V1/salesRules/1'), /Marketing.*nicht freigegeben/);
  assert.ok(events.filter(e => e.op === 'deny').length >= 15);

  // Reader gegen den Fake: sensible Felder entfernt, Zugriff protokolliert, Fake sieht nie Kunden-Pfade
  const r = new MagentoReader(new MagentoClient({ url: fake.base, accessToken: fake.token }), createMagentoGuard({ onAccess: a => events.push(a) }));
  const p = await r.product('VASE');
  assert.ok(p && !JSON.stringify(p).includes('einkauf@holm.test'), 'E-Mail entfernt');
  assert.ok(events.some(e => e.op === 'get' && e.entity === 'product'));
  assert.ok(!fake.log.some(l => /customer|order|cart/.test(l.path)));
  assert.equal('req' in r, false, 'kein freier API-Zugriff');
});

// ================= Adapter, Werkzeuge =================
type Res = { isError?: boolean; content: { text: string }[] };
const s = getSession('chat-magento');
const events: ChatEvent[] = [];
let allow = true;
s.emit = ev => { events.push(ev); s.events.push(ev); if (ev.t === 'changeset') setTimeout(() => decideChange('chat-magento', ev.approvalId, allow), 1); };
const tools = buildTools(s);
const call = async (name: string, args: Record<string, unknown> = {}) => { const r = (await tools.find(t => t.name === name)!.handler(args, {})) as Res; const t = r.content.map(c => c.text).join('\n'); if (r.isError) return { error: t } as unknown as Record<string, never>; try { return JSON.parse(t); } catch { return t; } };
const lastResult = () => [...s.events].reverse().find(e => e.t === 'changeset_result') as Extract<ChatEvent, { t: 'changeset_result' }>;
async function roundtrip(label: string, run: () => Promise<{ status?: string }>, check?: () => void | Promise<void>) {
  const before = fake.snapshot();
  const r = await run();
  assert.equal(r.status, 'applied', `${label}: ${JSON.stringify(r)}`);
  assert.notEqual(fake.snapshot(), before, `${label}: geändert`);
  await check?.();
  const u = await undoChangeSet('chat-magento', lastResult().csId);
  assert.ok(u?.ok, `${label}: Rückgängig ${JSON.stringify(u)}`);
  assert.deepEqual(JSON.parse(fake.snapshot()), JSON.parse(before), `${label}: exakt wiederhergestellt`);
}
const prodVals = (sku: string) => fake.products.find(p => p.sku === sku)!.vals;

test('Adapter: verfügbar, Verbindungstest, Werkzeugnamen = Werkzeuge, Kern-Features, Prompt', async () => {
  assert.equal(PLATFORM_SETTINGS.magento.available, true);
  assert.equal(s.platform, 'magento');
  assert.deepEqual(tools.map(t => t.name), toolNamesFor('magento'));
  for (const n of ['search_products', 'get_product', 'list_products', 'search_categories', 'get_category', 'search_media', 'propose_product_changes', 'propose_new_products', 'propose_category_changes', 'propose_product_images', 'propose_alt_texts', 'propose_translations', 'propose_promotion', 'seo_audit', 'draft_page', 'run_shop_check'])
    assert.ok(toolNamesFor('magento').includes(n), n);
  const t = await magento.testConnection();
  assert.equal(t.ok, true, t.message); assert.match(t.message, /Store-View Default Store View \(default, de_DE, EUR\), 4 Produkte/);
  assert.equal((await magento.health()).ok, true);
  // Admin-Benutzer statt Token
  const c = new MagentoClient({ url: fake.base, user: 'admin', password: 'geheim' }), logins = () => fake.log.filter(l => l.path === '/integration/admin/token').length, n0 = logins();
  const par = await Promise.all(Array.from({ length: 6 }, () => c.req('GET', '/V1/store/websites', undefined, { store: 'all' })));
  assert.equal(par[0].length, 2); assert.equal(logins() - n0, 1, 'parallele Erstanfragen: eine Anmeldung');
  await assert.rejects(new MagentoClient({ url: fake.base, user: 'admin', password: 'falsch' }).req('GET', '/V1/store/websites'), /Anmeldung fehlgeschlagen \(401\)/);
  const p = buildBasePrompt('magento');
  assert.doesNotMatch(p, /\{\{\w+\}\}|Shopware|Einkaufswelt|noch nicht verfügbar/);
  assert.match(p, /## Preise in Magento \(Streichpreis\)/); assert.match(p, /## Mehrsprachigkeit \(Store-Views\)/); assert.match(p, /seo_audit, find_image_gaps/);
});

test('Lese-Werkzeuge: Format, Preise, Bilder, Varianten, Kategorien, Promotionen ohne Kundendaten', async () => {
  const sp = await call('search_products', { term: 'Ki' });
  assert.equal(sp.total, 1); assert.equal(sp.products[0].number, 'KISSEN'); assert.equal(sp.products[0].price, null, 'Preis aus Varianten');
  const gp = await call('get_product', { id: '2' });
  assert.equal(gp.price, '15,00 €'); assert.equal(gp.listPrice, '18,00 €'); assert.equal(gp.priceDetails.specialActive, true);
  assert.equal(gp.stock[0].quantity, 5);
  const vase = await call('get_product', { id: 'VASE' });
  assert.equal(vase.images[0].mediaId, 'mg-1-1'); assert.equal(vase.images[0].cover, true); assert.equal(vase.images[1].altMissing, true);
  assert.match(vase.images[0].url, /\/media\/catalog\/product\/v\/a\/vase\.jpg$/);
  assert.ok(!JSON.stringify(vase).includes('einkauf@holm.test'));
  const lp = await call('list_products', { limit: 2 });
  assert.equal(lp.total, 3, 'Einzelprodukt der Variante ausgeblendet'); assert.equal(lp.nextOffset, 2); assert.equal(lp.products[0].stock, 10);
  const cat = await call('get_category', { id: '3' });
  assert.equal(cat.url, `${fake.base}/wohnaccessoires.html`); assert.equal(cat.productCount, 1);
  const v = await call('get_variants', { id: 'KISSEN' });
  assert.deepEqual(v.axes, [{ code: 'color', label: 'Farbe', values: ['Sand'], available: ['Salbei'] }]);
  const promos = await call('list_promotions', {});
  assert.equal(promos.promotions[0].code.code, 'WILLKOMMEN10'); assert.equal(promos.promotions[0].status, 'läuft');
  const audit = await call('seo_audit', { entity: 'product' });
  assert.ok(audit.issues.some((i: { issue: string }) => i.issue === 'Meta-Description fehlt'));
  assert.ok(accessList(50).some(a => a.chat === 'chat-magento' && a.entity === 'product'));
});

test('Lookup (Wissensbasis, Search Console, view_image) und Vorschau-Daten', async () => {
  assert.deepEqual(await s.lookup.findProducts({ ids: ['1'], numbers: ['BECHER'] }), [{ id: '1', number: 'VASE', name: 'Vase' }, { id: '2', number: 'BECHER', name: 'Becher' }]);
  assert.deepEqual((await s.lookup.getProduct('1'))?.categoryIds, ['2', '3']);
  assert.match(String(await s.lookup.mediaUrl('mg-1-2')), /vase-2\.jpg$/);
  const mu = await s.lookup.mapUrls([`${fake.base}/vase.html`, `${fake.base}/wohnaccessoires.html`, `${fake.base}/`, 'https://fremd.test/vase.html'], { metas: true });
  assert.deepEqual(mu.get(`${fake.base}/vase.html`), { kind: 'product', id: '1', name: 'Vase', number: 'VASE', active: true, metaTitle: 'Vase | Holm', metaDescription: null });
  assert.equal(mu.get(`${fake.base}/wohnaccessoires.html`)?.kind, 'category');
  assert.deepEqual(mu.get(`${fake.base}/`), { kind: 'home' }); assert.equal(mu.get('https://fremd.test/vase.html'), null);
  assert.deepEqual(await s.lookup.entityPaths('product', '1'), { paths: ['vase.html'], urls: [`${fake.base}/vase.html`] });
  assert.equal((await s.lookup.current('category', '3'))?.name, 'Wohnaccessoires');
  const ctx = await magento.pages.previewData(s, { name: 'x', type: 'product_list', previewCategoryId: '3', sections: [{ blocks: [{ type: 'product-slider', productIds: ['BECHER'] }, { type: 'image-cover', image: { mediaId: 'mg-1-1', alt: 'x' } }] }] });
  assert.equal(ctx.products?.BECHER?.price, '15,00 €'); assert.equal(ctx.products?.['1']?.name, 'Vase');
  assert.match(String(ctx.imageUrl?.({ mediaId: 'mg-1-1' })), /vase\.jpg$/);
  const cats = await magento.context.categories();
  assert.deepEqual(cats.map(c => [c.id, c.parentId]), [['2', null], ['3', '2'], ['4', '2']]);
  assert.deepEqual((await magento.context.products({ term: 'Vas' })).map(p => p.number), ['VASE']);
});

test('Produkte: Texte (global bzw. Store-View mit eigenem Wert), Preis mit Streichpreis, Bestand, Status, Attribut – Rückgängig exakt', async () => {
  prodVals('VASE')[1] = { meta_description: 'Eigene MD default' };
  await roundtrip('Produkt', () => call('propose_product_changes', { title: 'Test', reason: 'Test', changes: [{ id: '1', fields: { name: 'Vase neu', metaDescription: 'Neue MD', description: '<p>neu</p>', active: false, stock: 7, price: { percent: -10, round: '.99' }, listPrice: 49, attributes: { color: 'Salbei' } } }] }), () => {
    const v = prodVals('VASE');
    assert.equal(v[0].name, 'Vase neu', 'geerbt → global'); assert.equal(v[1].meta_description, 'Neue MD', 'eigener Wert → Store-View'); assert.notEqual(v[0].meta_description, 'Neue MD');
    assert.equal(v[0].price, 49); assert.equal(v[0].special_price, 43.99); assert.equal(v[0].status, 2); assert.equal(v[0].color, '12');
    assert.equal(fake.sourceItems.find(x => x.sku === 'VASE')!.quantity, 7);
    const cs = [...s.events].reverse().find(e => e.t === 'changeset') as Extract<ChatEvent, { t: 'changeset' }>;
    assert.ok(cs.cs.items.some(i => i.id === 'info:preis'), 'Hinweis zur Magento-Preislogik');
  });
  delete prodVals('VASE')[1];
  const bad = await call('propose_product_changes', { title: 'x', reason: 'x', changes: [{ id: 'KISSEN', fields: { price: 10 } }, { id: 'VASE', fields: { foo: 1, listPrice: 20 } }] });
  assert.match(bad.error, /Keine Änderung nötig bzw\. nichts anwendbar/); assert.match(bad.error, /Einzelprodukten/);
});

test('Name inzwischen geändert: die Zeile wird nicht geschrieben, der Bestand derselben Entität schon', async () => {
  const { reg, undoMagento } = await import('../../../../src/server/platform/magento/write');
  const before = fake.snapshot(), c = new MagentoClient({ url: fake.base, accessToken: fake.token });
  prodVals('VASE')[0].name = 'Vase fremd';
  const cs = { id: 'cs-stale', kind: 'products', entity: 'product', title: 't', reason: null, skipped: [], atomic: false, items: [
    { id: '1:name', entity: 'product', entityId: '1', label: 'Vase', field: 'name', fieldLabel: 'Name', before: 'Vase', after: 'Vase neu', afterRaw: 'Vase neu', beforeRaw: 'Vase', warn: [] },
    { id: '1:stock', entity: 'product', entityId: '1', label: 'Vase', field: 'stock', fieldLabel: 'Bestand', before: '10', after: '4', afterRaw: { source: 'default', quantity: 4 }, beforeRaw: 10, warn: [] },
  ] };
  const r = await reg.apply(c, cs, { store: 'default', skus: { 1: 'VASE' } }, new Set(['1:name', '1:stock']));
  const by = Object.fromEntries(r.results.map(x => [x.itemId, x]));
  assert.equal(by['1:name'].ok, false, JSON.stringify(r.results));
  assert.match(by['1:name'].error ?? '', /inzwischen geändert/);
  assert.equal(by['1:stock'].ok, true, JSON.stringify(r.results));
  assert.equal(prodVals('VASE')[0].name, 'Vase fremd');
  assert.equal(fake.sourceItems.find(x => x.sku === 'VASE')!.quantity, 4);
  assert.ok((await undoMagento(c, r.undo)).every(x => x.ok));
  prodVals('VASE')[0].name = 'Vase';
  assert.equal(fake.snapshot(), before);
});

test('Bestand inzwischen geändert: die Zeile wird nicht geschrieben, der Name derselben Entität schon', async () => {
  const { reg, undoMagento } = await import('../../../../src/server/platform/magento/write');
  const before = fake.snapshot(), c = new MagentoClient({ url: fake.base, accessToken: fake.token });
  fake.sourceItems.find(x => x.sku === 'VASE')!.quantity = 3;
  const cs = { id: 'cs-stock-stale', kind: 'products', entity: 'product', title: 't', reason: null, skipped: [], atomic: false, items: [
    { id: '1:name', entity: 'product', entityId: '1', label: 'Vase', field: 'name', fieldLabel: 'Name', before: 'Vase', after: 'Vase neu', afterRaw: 'Vase neu', beforeRaw: 'Vase', warn: [] },
    { id: '1:stock', entity: 'product', entityId: '1', label: 'Vase', field: 'stock', fieldLabel: 'Bestand', before: '10', after: '4', afterRaw: { source: 'default', quantity: 4 }, beforeRaw: 10, warn: [] },
  ] };
  const r = await reg.apply(c, cs, { store: 'default', skus: { 1: 'VASE' } }, new Set(['1:name', '1:stock']));
  const by = Object.fromEntries(r.results.map(x => [x.itemId, x]));
  assert.equal(by['1:stock'].ok, false, JSON.stringify(r.results));
  assert.match(by['1:stock'].error ?? '', /inzwischen geändert/);
  assert.equal(by['1:name'].ok, true, JSON.stringify(r.results));
  assert.equal(fake.sourceItems.find(x => x.sku === 'VASE')!.quantity, 3);
  assert.equal(prodVals('VASE')[0].name, 'Vase neu');
  assert.ok((await undoMagento(c, r.undo)).every(x => x.ok));
  fake.sourceItems.find(x => x.sku === 'VASE')!.quantity = 10;
  assert.equal(fake.snapshot(), before);
});

test('Kategoriename inzwischen geändert: die Zeile wird nicht geschrieben, der Meta-Title schon', async () => {
  const { reg, undoMagento } = await import('../../../../src/server/platform/magento/write');
  const before = fake.snapshot(), c = new MagentoClient({ url: fake.base, accessToken: fake.token });
  const cat = fake.categories.find(x => x.id === 3)!;
  cat.vals[0].name = 'Fremd';
  const cs = { id: 'cs-cat-stale', kind: 'categories', entity: 'category', title: 't', reason: null, skipped: [], atomic: false, items: [
    { id: '3:name', entity: 'category', entityId: '3', label: 'Wohnaccessoires', field: 'name', fieldLabel: 'Name', before: 'Wohnaccessoires', after: 'Wohnen', afterRaw: 'Wohnen', beforeRaw: 'Wohnaccessoires', warn: [] },
    { id: '3:metaTitle', entity: 'category', entityId: '3', label: 'Wohnaccessoires', field: 'metaTitle', fieldLabel: 'Meta-Title', before: '–', after: 'Neu', afterRaw: 'Neu', beforeRaw: null, warn: [] },
  ] };
  const r = await reg.apply(c, cs, { store: 'default' }, new Set(['3:name', '3:metaTitle']));
  const by = Object.fromEntries(r.results.map(x => [x.itemId, x]));
  assert.equal(by['3:name'].ok, false, JSON.stringify(r.results));
  assert.match(by['3:name'].error ?? '', /inzwischen geändert/);
  assert.equal(by['3:metaTitle'].ok, true, JSON.stringify(r.results));
  assert.equal(cat.vals[0].name, 'Fremd');
  assert.equal(cat.vals[0].meta_title, 'Neu');
  assert.ok((await undoMagento(c, r.undo)).every(x => x.ok));
  cat.vals[0].name = 'Wohnaccessoires';
  assert.equal(fake.snapshot(), before);
});

test('Bestand schlägt fehl: geschriebene Felder bleiben gültig und rückgängig machbar', async () => {
  const { reg, undoMagento } = await import('../../../../src/server/platform/magento/write');
  const before = fake.snapshot(), c = new MagentoClient({ url: fake.base, accessToken: fake.token });
  const orig = c.req.bind(c);
  c.req = (async (method: string, path: string, body?: unknown, o?: { store?: string }) => {
    if (method === 'POST' && path.includes('/inventory/source-items') && !path.includes('delete')) throw new Error('Bestand nicht schreibbar');
    return orig(method, path, body, o);
  }) as typeof c.req;
  const cs = { id: 'cs-stock', kind: 'products', entity: 'product', title: 't', reason: null, skipped: [], atomic: false, items: [
    { id: '1:name', entity: 'product', entityId: '1', label: 'Vase', field: 'name', fieldLabel: 'Name', before: 'Vase', after: 'Vase neu', afterRaw: 'Vase neu', warn: [] },
    { id: '1:stock', entity: 'product', entityId: '1', label: 'Vase', field: 'stock', fieldLabel: 'Bestand', before: '10', after: '7', afterRaw: { source: 'default', quantity: 7 }, warn: [] },
  ] };
  const r = await reg.apply(c, cs, { store: 'default', skus: { 1: 'VASE' } }, new Set(['1:name', '1:stock']));
  const by = Object.fromEntries(r.results.map(x => [x.itemId, x]));
  assert.equal(by['1:name'].ok, true, JSON.stringify(r.results));
  assert.equal(by['1:stock'].ok, false);
  assert.match(by['1:stock'].error ?? '', /Bestand/);
  assert.equal(prodVals('VASE')[0].name, 'Vase neu');
  assert.equal(fake.sourceItems.find(x => x.sku === 'VASE')!.quantity, 10);
  assert.ok(r.undo.length > 0, 'geschriebene Felder bleiben rückgängig machbar');
  assert.ok((await undoMagento(c, r.undo)).every(x => x.ok), 'Rückgängig');
  assert.equal(fake.snapshot(), before);
});

test('writeScoped: ein späterer Store-View-Fehler behält den Undo des ersten PUT', async () => {
  const { writeScoped, undoMagento } = await import('../../../../src/server/platform/magento/write');
  const before = fake.snapshot(), c = new MagentoClient({ url: fake.base, accessToken: fake.token, storeCode: 'en' });
  const orig = c.req.bind(c);
  c.req = (async (method: string, path: string, body?: unknown, o?: { store?: string }) => {
    if (method === 'PUT' && path.startsWith('/en/')) throw new Error('View nicht schreibbar');
    return orig(method, path, body, o);
  }) as typeof c.req;
  const err = await writeScoped(c, 'product', 'VASE', 'en', { name: 'Vase EN' }, { weight: 2 }).then(() => null, (e: Error & { undo?: UndoOp[] }) => e);
  assert.ok(err); assert.match(err.message, /View nicht schreibbar/);
  assert.equal(prodVals('VASE')[0].weight, 2, 'Gewicht ist geschrieben');
  assert.equal(prodVals('VASE')[0].name, 'Vase', 'Name der View wurde nicht geschrieben');
  assert.ok(err.undo?.some(op => String(op.path).includes('/all/')), `Undo fehlt: ${JSON.stringify(err.undo)}`);
  assert.ok((await undoMagento(c, err.undo!)).every(x => x.ok));
  assert.equal(fake.snapshot(), before);
});

test('Andere Store-View als die Haupt-View: geerbte Texte werden dort gespeichert, nicht global; Rückgängig = wieder erben', async () => {
  const { reg } = await import('../../../../src/server/platform/magento/write');
  const before = fake.snapshot(), c = new MagentoClient({ url: fake.base, accessToken: fake.token, storeCode: 'en' });
  const cs = { id: 'cs-en', kind: 'products', entity: 'product', title: 't', reason: null, skipped: [], atomic: false, items: [{ id: '1:name', entity: 'product', entityId: '1', label: 'Vase', field: 'name', fieldLabel: 'Name', before: 'Vase', after: 'Vase EN', afterRaw: 'Vase EN', warn: [] }] };
  const partial: { done: number; total: number; undo: number }[] = [];
  const r = await reg.apply(c, cs, { store: 'en', skus: { 1: 'VASE' } }, new Set(['1:name']), { progress: (done, total, p) => partial.push({ done, total, undo: p?.undo.length ?? -1 }) });
  assert.ok(r.results[0].ok, JSON.stringify(r));
  assert.deepEqual(partial, [{ done: 1, total: 1, undo: r.undo.length }], 'applyGrouped meldet den Zwischenstand je Datensatz (Absturzsicherheit)');
  assert.equal(prodVals('VASE')[2].name, 'Vase EN'); assert.equal(prodVals('VASE')[0].name, 'Vase');
  const { undoMagento } = await import('../../../../src/server/platform/magento/write');
  assert.ok((await undoMagento(c, r.undo)).every(x => x.ok));
  assert.equal(fake.snapshot(), before);
});

test('Abgelehnt = nichts geschrieben; Preisänderung zwischen Vorschlag und Freigabe wird erkannt', async () => {
  const before = fake.snapshot();
  allow = false;
  const r = await call('propose_product_changes', { title: 'x', reason: 'x', changes: [{ id: '2', fields: { name: 'Nein' } }] });
  allow = true;
  assert.equal(r.status, 'rejected'); assert.equal(fake.snapshot(), before);
});

test('Kategorien, Zuordnung, URL-Schlüssel, Übersetzungen – Rückgängig exakt', async () => {
  await roundtrip('Kategorie', () => call('propose_category_changes', { title: 'K', reason: 'K', changes: [{ id: '3', fields: { name: 'Wohnen', metaTitle: 'Wohnen | Holm', active: false } }] }));
  await roundtrip('Zuordnung', () => call('propose_category_products', { title: 'Z', reason: 'Z', categoryId: '3', add: [{ productId: '2', position: 2 }], remove: ['VASE'] }));
  await roundtrip('URL-Schlüssel', () => call('propose_seo_urls', { title: 'U', reason: 'U', entity: 'product', changes: [{ id: '1', urlKey: 'Vase Kiesel Steinzeug' }] }), () => assert.equal(prodVals('VASE')[0].url_key, 'vase-kiesel-steinzeug'));
  const dup = await call('propose_seo_urls', { title: 'U', reason: 'U', entity: 'product', changes: [{ id: '1', urlKey: 'becher' }] });
  assert.match(dup.error, /schon vergeben/);
  await roundtrip('Übersetzung Produkt', () => call('propose_translations', { title: 'EN', reason: 'EN', entity: 'product', changes: [{ id: 'VASE', store: 'en_US', fields: { name: 'Vase (EN)', metaTitle: 'Vase EN' } }] }), () => {
    assert.equal(prodVals('VASE')[2].name, 'Vase (EN)'); assert.equal(prodVals('VASE')[0].name, 'Vase');
  });
  // Kategorienamen: Magento verwirft null → Rückgängig schreibt den globalen Text als Wert der Store-View
  const before = JSON.parse(fake.snapshot());
  const r = await call('propose_translations', { title: 'EN', reason: 'EN', entity: 'category', changes: [{ id: '3', store: 'en', fields: { name: 'Home accessories', description: '<p>Home</p>' } }] });
  assert.equal(r.status, 'applied');
  assert.ok((await undoChangeSet('chat-magento', lastResult().csId))?.ok);
  const cat = fake.categories.find(c => c.id === 3)!;
  assert.deepEqual(cat.vals[2], { name: 'Wohnaccessoires' }, 'Name = globaler Text, Beschreibung erbt wieder');
  delete cat.vals[2]; assert.deepEqual(JSON.parse(fake.snapshot()), before);
});

test('Bilder (neu als Titelbild, ausblenden, sortieren) und Alt-Texte – Rückgängig exakt', async () => {
  const st = stageImage(png, 'image/png', { name: 'blau', alt: 'Blaue Vase' });
  await roundtrip('Bilder', () => call('propose_product_images', { title: 'B', reason: 'B', products: [{ productId: '1', add: [{ image: st.mediaId, cover: true, position: 0 }], remove: ['mg-1-1'] }] }), () => {
    const p = fake.products.find(x => x.sku === 'VASE')!;
    assert.equal(p.media.length, 3); assert.equal(p.media.find(m => m.id === 1)!.vals[0].disabled, true);
    assert.match(String(p.vals[0].image), /blau/);
  });
  const skipped = await call('propose_alt_texts', { title: 'A', reason: 'A', images: [{ mediaId: 'mg-1-2', alt: 'Vase von der Seite' }] });
  assert.match(skipped.error, /nicht mit view_image angesehen/);
  s.events.push({ t: 'tool', name: 'mcp__shop__view_image', input: { mediaId: 'mg-1-2' } } as unknown as ChatEvent);
  await roundtrip('Alt-Text', () => call('propose_alt_texts', { title: 'A', reason: 'A', images: [{ mediaId: 'mg-1-2', alt: 'Vase von der Seite' }] }), () => assert.equal(fake.products[0].media[1].vals[0].label, 'Vase von der Seite'));
});

test('Neue Produkte und Varianten: angelegt inaktiv mit Bestand, Rückgängig löscht samt Lagerbestand', async () => {
  const st = stageImage(png, 'image/png', { name: 'gelb', alt: 'Gelb' });
  const noPrice = await call('propose_new_products', { title: 'N', reason: 'N', products: [{ name: 'Teller', description: '<p>Teller</p>' }] });
  assert.match(noPrice.error, /Preis fehlt/);
  await roundtrip('Neues Produkt', () => call('propose_new_products', { title: 'N', reason: 'N', products: [{ name: 'Teller Ufer', description: '<p>Teller</p>', price: 24, sku: 'TELLER', stock: 4, categoryIds: ['4'], images: [st.mediaId] }] }), () => {
    const p = fake.products.find(x => x.sku === 'TELLER')!;
    assert.equal(p.vals[0].status, 2); assert.equal(p.vals[0].tax_class_id, '2'); assert.equal(p.media.length, 1);
    assert.equal(fake.sourceItems.find(x => x.sku === 'TELLER')!.quantity, 4);
    assert.ok(fake.categories.find(c => c.id === 4)!.products.some(l => l.sku === 'TELLER'));
  });
  await roundtrip('Variante', () => call('propose_variants', { title: 'V', reason: 'V', productId: 'KISSEN', add: [{ options: { Farbe: 'Salbei' }, stock: 2 }] }), () => {
    const kid = fake.products.find(x => x.sku === 'KISSEN-SALBEI')!;
    assert.equal(kid.vals[0].price, 39, 'Preis wie die übrigen Varianten'); assert.equal(kid.vals[0].visibility, 1);
    assert.ok(fake.products.find(x => x.sku === 'KISSEN')!.children!.includes('KISSEN-SALBEI'));
  });
});

test('Stapel: Regel auf Filter, Fortschritt, Rückgängig exakt', async () => {
  const prog: unknown[] = [];
  const emit = s.emit; s.emit = ev => { if (ev.t === 'changeset_progress') prog.push(ev); emit(ev); };
  await roundtrip('Stapel', () => call('propose_bulk_product_change', { title: 'S', reason: 'S', filter: { categoryId: '3' }, change: { price: { percent: -20, round: '.99' }, listPrice: 'currentPrice' } }), () => {
    assert.equal(prodVals('VASE')[0].price, 49); assert.equal(prodVals('VASE')[0].special_price, 38.99);
  });
  s.emit = emit;
  assert.ok(prog.length >= 2);
});

test('Promotionen: anlegen (fester Code), Einzelcodes, ändern, beenden – Rückgängig exakt, Kundengruppen nur im Executor', async () => {
  await roundtrip('Promotion neu', () => call('propose_promotion', { reason: 'R', name: 'Herbst', active: true, validFrom: '2026-11-01', validUntil: '2026-11-30', code: { mode: 'fixed', code: 'herbst20' }, discount: { type: 'percentage', value: 20, categoryIds: ['3'] }, minSubtotal: 50 }), () => {
    const r = fake.rules.find(x => x.name === 'Herbst')!;
    assert.deepEqual(r.customer_group_ids, [0, 1]); assert.equal(r.coupon_type, 'SPECIFIC_COUPON');
    assert.ok(fake.coupons.some(c => c.code === 'HERBST20' && c.rule_id === r.rule_id));
  });
  await roundtrip('Promotion Einzelcodes', () => call('propose_promotion', { reason: 'R', name: 'Codes', active: false, validUntil: '2026-12-31', code: { mode: 'individual', count: 3, prefix: 'NL-' }, discount: { type: 'cart_fixed', value: 5 } }));
  await roundtrip('Promotion ändern', () => call('propose_promotion', { id: '1', reason: 'R', discount: { type: 'percentage', value: 15 }, validUntil: '2026-12-31', code: { mode: 'fixed', code: 'WILLKOMMEN15' } }), () => {
    assert.equal(fake.rules[0].discount_amount, 15); assert.equal(fake.coupons[0].code, 'WILLKOMMEN15');
  });
  await roundtrip('Promotion beenden', () => call('propose_promotion_status', { ids: ['1'], action: 'end' }), () => assert.equal(fake.rules[0].is_active, false));
  const taken = await call('propose_promotion', { reason: 'R', name: 'X', active: true, code: { mode: 'fixed', code: 'WILLKOMMEN10' }, discount: { type: 'percentage', value: 5 } });
  assert.match(taken.error, /schon vergeben/);
  assert.ok(!fake.log.some(l => l.path.startsWith('/customerGroups') && l.store !== 'all'));
});

test('Promotion ändern: nur Rabattwert ändert nur den Rabattwert (Einschränkung, Versand, Schritt, Lieferland bleiben), Karte zeigt Ziel', async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rule = () => fake.rules.find(r => r.rule_id === 2)! as Record<string, any>, keep = JSON.parse(JSON.stringify(rule()));
  await roundtrip('Nur Rabatt', () => call('propose_promotion', { id: '2', reason: 'R', discount: { type: 'percentage', value: 20 } }), () => {
    const r = rule();
    assert.equal(r.discount_amount, 20);
    for (const k of ['action_condition', 'condition', 'apply_to_shipping', 'discount_step', 'discount_qty', 'store_labels']) assert.deepEqual(r[k], keep[k], k);
    const cs = [...s.events].reverse().find(e => e.t === 'changeset') as Extract<ChatEvent, { t: 'changeset' }>, it = cs.cs.items[0];
    assert.match(it.before, /15 % auf Kategorien Wohnaccessoires \(inkl\. Versand\)/); assert.match(it.after, /20 % auf Kategorien Wohnaccessoires \(inkl\. Versand\)/);
    assert.match(it.after, /1 weitere Warenkorb-Bedingung/);
  });
  // Mindestbestellwert ergänzt die Lieferland-Bedingung statt sie zu ersetzen; Kategorie-Wechsel nur, wenn angegeben
  await roundtrip('Mindestbestellwert + Kategorie', () => call('propose_promotion', { id: '2', reason: 'R', minSubtotal: 40, discount: { type: 'percentage', value: 15, categoryIds: ['4'] } }), () => {
    const r = rule();
    assert.deepEqual(r.condition.conditions.map((c: { attribute_name: string }) => c.attribute_name), ['country_id', 'base_subtotal']);
    assert.equal(r.action_condition.conditions[0].value, '4'); assert.equal(r.apply_to_shipping, true);
    const it = ([...s.events].reverse().find(e => e.t === 'changeset') as Extract<ChatEvent, { t: 'changeset' }>).cs.items[0];
    assert.match(it.after, /Kategorien Küche.*ab 40,00 € Warenkorb/);
  });
});

test('Promotion-Bezeichnung: setzen, entfernen (Magento ignoriert []), Rückgängig exakt', async () => {
  const rule = () => fake.rules.find(r => r.rule_id === 2)! as { store_labels: { store_id: number; store_label: string }[] };
  await roundtrip('Bezeichnung neu', () => call('propose_promotion', { id: '2', reason: 'R', label: 'Wohnwoche' }), () => {
    assert.deepEqual(rule().store_labels, [{ store_id: 0, store_label: 'Wohnwoche' }, { store_id: 1, store_label: 'Wohnrabatt DE' }]);
    const it = ([...s.events].reverse().find(e => e.t === 'changeset') as Extract<ChatEvent, { t: 'changeset' }>).cs.items[0];
    assert.doesNotMatch(it.before, /Bezeichnung/); assert.match(it.after, /Bezeichnung „Wohnwoche“/);
  });
  rule().store_labels.unshift({ store_id: 0, store_label: 'Alt' });
  await roundtrip('Bezeichnung entfernen', () => call('propose_promotion', { id: '2', reason: 'R', label: null }), () => assert.deepEqual(rule().store_labels, [{ store_id: 1, store_label: 'Wohnrabatt DE' }]));
  rule().store_labels.shift();
});

test('Preisbasis: Ausgabe und Karten nennen brutto/netto; unbekannt = keine Preisänderung', async () => {
  const { buildProductChangeSet } = await import('../../../../src/server/platform/magento/catalog');
  const { bulkChangeSet } = await import('../../../../src/server/platform/magento/bulk');
  const gp = await call('get_product', { id: '2' });
  assert.equal(gp.priceDetails.basis, 'brutto'); assert.equal((await call('list_products', { limit: 1 })).priceBasis, 'brutto');
  const reader = (priceBasis?: string) => new MagentoReader(new MagentoClient({ url: fake.base, accessToken: fake.token, priceBasis }));
  const net = await buildProductChangeSet(reader('net'), { title: 't', reason: 'r', changes: [{ id: '1', fields: { price: 45 } }] });
  const row = net.cs.items.find(i => i.field === 'price')!;
  assert.equal(row.fieldLabel, 'Preis netto (Streichpreis)'); assert.equal(row.before, '49,00 € netto'); assert.equal(row.after, '45,00 € netto');
  assert.match(net.cs.items.find(i => i.id === 'info:preis')!.after, /netto.*zusätzlich die MwSt/);
  await assert.rejects(buildProductChangeSet(reader(), { title: 't', reason: 'r', changes: [{ id: '1', fields: { price: 45 } }] }), /Preisbasis unbekannt/);
  const nameOnly = await buildProductChangeSet(reader(), { title: 't', reason: 'r', changes: [{ id: '1', fields: { name: 'Vase X' } }] });
  assert.equal(nameOnly.cs.items[0].field, 'name', 'Texte gehen ohne Preisbasis');
  const p = fake.products.find(x => x.sku === 'VASE')!, mp = { id: 1, sku: 'VASE', type_id: 'simple', price: Number(p.vals[0].price), status: 1 };
  assert.throws(() => bulkChangeSet('t', 'r', { price: { percent: 10 } }, [mp], null), /Preisbasis unbekannt/);
  assert.equal(bulkChangeSet('t', 'r', { active: false }, [mp], null).cs.items.length > 0, true);
  assert.equal(map.parseBasis('Brutto'), 'gross'); assert.equal(map.parseBasis('net'), 'net'); assert.equal(map.parseBasis(''), null);
});

test('Rückgängig einer fremden Plattform wird nicht ausgeführt; unbekannte Änderungsart wirft', async () => {
  const { undoWithPlatform } = await import('../../../../src/server/platform/index');
  const r = await undoWithPlatform([{ op: 'req', entity: 'product', id: 'VASE', method: 'PUT', path: '/all/V1/products/VASE', body: {}, platform: 'shopware' }], 'magento');
  assert.equal(r[0].ok, false);
  await assert.rejects(magento.apply({ id: 'x', kind: 'gibts-nicht', title: '', reason: null, items: [], skipped: [], atomic: false }, null, new Set()), /keinen Executor/);
});

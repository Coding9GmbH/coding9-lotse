// OpenMage: reine Logik, Datenschutz-Guard, Adapter, Lese-Werkzeuge, Änderungssets mit exaktem Rückgängig gegen den Fake der Modul-API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatEvent } from '@/lib/protocol';
import { startFakeOpenmage, type FakeProduct } from './fake';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-openmage-'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const prod = (id: number, sku: string, v: Record<string, unknown>, extra: Partial<FakeProduct> = {}): FakeProduct => ({ id, sku, type_id: 'simple', attribute_set_id: 4, website_ids: [1], images: [], categories: [], stock: { qty: 10, is_in_stock: true, manage_stock: true }, vals: { 0: { status: 1, visibility: 4, url_key: sku.toLowerCase(), tax_class_id: 2, ...v } }, ...extra });
const fake = await startFakeOpenmage({
  categories: [
    { id: 1, parent_id: 0, level: 0, path: '1', position: 0, vals: { 0: { name: 'Root Catalog', is_active: true } } },
    { id: 2, parent_id: 1, level: 1, path: '1/2', position: 1, vals: { 0: { name: 'Default Category', is_active: true } } },
    { id: 3, parent_id: 2, level: 2, path: '1/2/3', position: 1, vals: { 0: { name: 'Wohnaccessoires', is_active: true, description: '<p>Wohnen</p>', url_key: 'wohnaccessoires', display_mode: 'PRODUCTS', is_anchor: true } } },
    { id: 4, parent_id: 2, level: 2, path: '1/2/4', position: 2, vals: { 0: { name: 'Küche', is_active: true, url_key: 'kueche', display_mode: 'PRODUCTS' } } },
  ],
  products: [
    prod(1, 'VASE', { name: 'Vase', price: 49, description: '<p>Vase aus Steinzeug</p>', meta_title: 'Vase | Holm', contact_email: 'einkauf@holm.test', image: '/v/a/vase.jpg', small_image: '/v/a/vase.jpg', thumbnail: '/v/a/vase.jpg' },
      { categories: [{ id: 3, position: 1 }], images: [{ id: 1, file: '/v/a/vase.jpg', vals: { 0: { label: 'Vase', position: 1, disabled: false } } }, { id: 2, file: '/v/a/vase-2.jpg', vals: { 0: { label: '', position: 2, disabled: false } } }] }),
    prod(2, 'BECHER', { name: 'Becher', price: 18, special_price: 15, special_from_date: '2020-01-01' }, { categories: [{ id: 4, position: 1 }], stock: { qty: 5, is_in_stock: true, manage_stock: true } }),
    prod(3, 'KISSEN', { name: 'Kissen', price: null }, { type_id: 'configurable', children: ['KISSEN-SAND'], axes: ['color'], stock: { qty: 0, is_in_stock: true, manage_stock: false } }),
    prod(4, 'KISSEN-SAND', { name: 'Kissen Sand', price: 39, visibility: 1, color: 3 }, { stock: { qty: 3, is_in_stock: true, manage_stock: true } }),
  ],
  rules: [{ id: 1, name: 'Willkommen', description: null, is_active: true, from_date: null, to_date: null, coupon_type: 2, coupon_code: 'WILLKOMMEN10', uses_per_coupon: null, uses_per_customer: 1, times_used: 2, simple_action: 'by_percent', discount_amount: 10, discount_qty: null, discount_step: 0, apply_to_shipping: false, simple_free_shipping: 0, stop_rules_processing: false, sort_order: 0, website_ids: [1], customer_group_ids: [0, 1, 2, 3], conditions: { type: 'salesrule/rule_condition_combine', attribute: null, operator: null, value: true, aggregator: 'all' }, actions: { type: 'salesrule/rule_condition_product_combine', attribute: null, operator: null, value: true, aggregator: 'all' } },
    { id: 2, name: 'Wohnen', description: null, is_active: true, from_date: '2026-01-01', to_date: null, coupon_type: 1, coupon_code: null, uses_per_coupon: null, uses_per_customer: 0, times_used: 0, simple_action: 'by_percent', discount_amount: 15, discount_qty: 5, discount_step: 2, apply_to_shipping: true, simple_free_shipping: 0, stop_rules_processing: false, sort_order: 1, website_ids: [1], customer_group_ids: [0, 1, 2, 3],
      conditions: { type: 'salesrule/rule_condition_combine', aggregator: 'all', value: true, conditions: [{ type: 'salesrule/rule_condition_address', attribute: 'country_id', operator: '==', value: 'DE' }] },
      actions: { type: 'salesrule/rule_condition_product_combine', aggregator: 'all', value: true, conditions: [{ type: 'salesrule/rule_condition_product', attribute: 'category_ids', operator: '()', value: '3' }] } }],
  cmsPages: [{ id: 1, identifier: 'no-route', title: '404', content: '<p>404</p>', is_active: true, store_ids: [0], root_template: 'two_columns_right', content_heading: null, meta_keywords: null, meta_description: null, sort_order: 0 }],
});
process.env.SHOP_PLATFORM = 'openmage';
process.env.OPENMAGE_URL = fake.base;
process.env.OPENMAGE_TOKEN = fake.token;

const map = await import('./map');
const { stripTitleAffixes } = map;
const { createOmGuard, OmReader } = await import('./reader');
const { OmClient, omMessage } = await import('./client');
const { openmage } = await import('./index');
const { getSession, decideChange, undoChangeSet } = await import('../../sessions');
const { buildTools, toolNamesFor } = await import('../../tools');
const { stageImage } = await import('../../media');
const { accessList } = await import('../../db');
const { buildBasePrompt } = await import('../../prompt');
const { PLATFORM_SETTINGS } = await import('@/lib/platforms');

test.after(() => fake.close());

// ================= reine Logik =================
test('Theme-Suffix/-Präfix im Titel: nur ein doppeltes Ende/Anfang wird entfernt', () => {
  const v = { title_prefix: '', title_suffix: ' | Haus Holm' };
  assert.equal(stripTitleAffixes('Vase „Kiesel“ kaufen | Haus Holm', v), 'Vase „Kiesel“ kaufen');
  assert.equal(stripTitleAffixes('Vase kaufen – haus holm ', v), 'Vase kaufen');
  assert.equal(stripTitleAffixes('Vase kaufen bei Haus Holm', v), 'Vase kaufen bei Haus Holm', 'kein Trenner, kein Suffix');
  assert.equal(stripTitleAffixes(' | Haus Holm', v), '| Haus Holm', 'nur das Suffix bleibt, nie leer');
  assert.equal(stripTitleAffixes('Vase - haus holm', v), 'Vase', 'anderer Trenner, andere Schreibweise');
  assert.equal(stripTitleAffixes('Haus Holm: Vasen', { title_prefix: 'Haus Holm:' }), 'Vasen');
  assert.equal(stripTitleAffixes('Vase | Haus Holm', undefined), 'Vase | Haus Holm');
});

test('Abbildung: Preise über mrec, Medien-ID, URL-Pfade, Rewrite-Ziele, Identifier', () => {
  const p = { id: 2, sku: 'BECHER', type_id: 'simple', price: 18, special_price: 15, special_from_date: '2020-01-01', special_to_date: null, images: [{ id: 1, file: '/a.jpg', url: '', label: 'x', position: 1, disabled: false, types: ['image'] }] };
  const s = map.priceOf(p, '2026-10-10');
  assert.deepEqual([s.selling, s.list, s.active], [15, 18, true]);
  assert.equal(map.mrec(p).media_gallery_entries[0].label, 'x');
  assert.deepEqual(map.parseMediaId(map.mediaId(12, 7)), { productId: '12', imageId: 7 });
  assert.equal(map.parseMediaId('mg-1-2'), null);
  assert.equal(map.productPath({ url_key: 'vase' }), 'vase.html'); assert.equal(map.productPath({ url_key: null }), null);
  assert.equal(map.categoryPath({ url_path: 'wohnen/vasen.html' }), 'wohnen/vasen.html'); assert.equal(map.categoryPath({ url_key: 'wohnen' }), 'wohnen.html');
  assert.deepEqual(map.parseTarget('catalog/product/view/id/1/category/3'), { type: 'PRODUCT', id: 1, categoryId: 3 });
  assert.deepEqual(map.parseTarget('catalog/category/view/id/3'), { type: 'CATEGORY', id: 3 }); assert.equal(map.parseTarget('cms/page/view'), null);
  assert.equal(map.cmsIdentifier(' /Ratgeber/Vasen & Schalen.html?x=1'), 'ratgeber/vasen-schalen.html');
  assert.throws(() => map.cmsIdentifier('/'), /url fehlt/);
  assert.ok(map.same(1, '1') && map.same(true, 1) && map.same(null, '') && !map.same('a', 'b'));
  assert.equal(map.omAttr({ attributes: { description: 'd' }, description: 'x' }, 'description'), 'd'); assert.equal(map.omStr({ name: '' }, 'name'), null);
  assert.deepEqual(omMessage({ error: { code: 'validation', message: 'Nein', details: { messages: ['a', 'b'] } } }, ''), { message: 'Nein; a; b', code: 'validation' });
  assert.equal(omMessage(null, '<html>Fatal</html>').message, 'Fatal');
});

test('Client: Pfade mit Store-Query, nur /v1-Pfade, ungültige Store-Codes abgewiesen', () => {
  const c = new OmClient({ url: 'https://shop.test/', token: 't' });
  assert.equal(c.url('/v1/products/VASE', { store: 'en' }), 'https://shop.test/lotse-api/v1/products/VASE?store=en');
  assert.equal(c.url('/v1/products/VASE?store=en', { store: 'admin' }), 'https://shop.test/lotse-api/v1/products/VASE');
  assert.equal(c.url('/v1/products', { query: { skus: 'A,B', limit: 50, with: undefined } }), 'https://shop.test/lotse-api/v1/products?skus=A%2CB&limit=50');
  assert.throws(() => c.url('/rest/V1/x'), /Ungültiger OpenMage-Pfad/);
  assert.throws(() => c.url('/v1/products', { store: 'x y' }), /Ungültiger Store-Code/);
});

// ================= Datenschutz =================
test('Guard: Kunden, Bestellungen, Warenkörbe, Benutzer gesperrt; nur Freigabeliste; Bereiche schaltbar; Query-Parameter geprüft; Protokoll', async () => {
  const events: { op: string; entity: string; denied?: string }[] = [];
  let scopes = { products: true, categories: true, cms: true, media: true, marketing: true, shop: true };
  const g = createOmGuard({ getScopes: () => scopes, onAccess: a => events.push(a) });
  for (const p of ['/v1/customers', '/v1/customers/1', '/v1/orders', '/v1/orders/1', '/v1/invoices', '/v1/carts', '/v1/quote/1', '/v1/users', '/v1/api_users', '/v1/payments', '/v1/newsletter', '/v1/config', '/v1/admin/token'])
    assert.throws(() => g.check(p), /ZUGRIFF VERWEIGERT/, p);
  assert.throws(() => g.check('/v1/products', { customer_id: 1 }), /nicht freigegeben/);
  assert.throws(() => g.check('/v1/products', { fields: 'description,password_hash' }), /nicht freigegeben/);
  assert.throws(() => g.check('/v1/salesrules', { customer_group_id: 1 }), /nicht freigegeben/);
  assert.equal(g.check('/v1/products/ORDER-BOX'), 'product', 'SKU mit „order“ ist ein Produkt');
  assert.equal(g.check('/v1/products', { fields: 'description,meta_title', with: 'images', name: 'Order' }), 'product');
  assert.equal(g.check('/v1/salesrules/1/coupons', { page: 1 }), 'coupon');
  scopes = { ...scopes, marketing: false };
  assert.throws(() => g.check('/v1/salesrules/1'), /Marketing.*nicht freigegeben/);
  assert.ok(events.filter(e => e.op === 'deny').length >= 15);

  const r = new OmReader(new OmClient({ url: fake.base, token: fake.token }), createOmGuard({ onAccess: a => events.push(a) }));
  const p = await r.product('VASE');
  assert.ok(p && !JSON.stringify(p).includes('einkauf@holm.test'), 'E-Mail-Attribut entfernt');
  assert.ok(events.some(e => e.op === 'get' && e.entity === 'product'));
  assert.ok(!fake.log.some(l => /customer|order|cart/.test(l.path)));
  assert.equal('req' in r, false, 'kein freier API-Zugriff');
  const wrong = new OmClient({ url: fake.base, token: 'falsch' });
  await assert.rejects(wrong.req('GET', '/v1/info'), /401/);
});

// ================= Adapter, Werkzeuge =================
type Res = { isError?: boolean; content: { text: string }[] };
const s = getSession('chat-openmage');
const events: ChatEvent[] = [];
let allow = true;
s.emit = ev => { events.push(ev); s.events.push(ev); if (ev.t === 'changeset') setTimeout(() => decideChange('chat-openmage', ev.approvalId, allow), 1); };
const tools = buildTools(s);
const call = async (name: string, args: Record<string, unknown> = {}) => { const r = (await tools.find(t => t.name === name)!.handler(args, {})) as Res; const t = r.content.map(c => c.text).join('\n'); if (r.isError) return { error: t } as unknown as Record<string, never>; try { return JSON.parse(t); } catch { return t; } };
const lastResult = () => [...s.events].reverse().find(e => e.t === 'changeset_result') as Extract<ChatEvent, { t: 'changeset_result' }>;
const lastCs = () => [...s.events].reverse().find(e => e.t === 'changeset') as Extract<ChatEvent, { t: 'changeset' }>;
async function roundtrip(label: string, run: () => Promise<{ status?: string }>, check?: () => void | Promise<void>) {
  const before = fake.snapshot();
  const r = await run();
  assert.equal(r.status, 'applied', `${label}: ${JSON.stringify(r)}`);
  assert.notEqual(fake.snapshot(), before, `${label}: geändert`);
  await check?.();
  const u = await undoChangeSet('chat-openmage', lastResult().csId);
  assert.ok(u?.ok, `${label}: Rückgängig ${JSON.stringify(u)}`);
  assert.deepEqual(JSON.parse(fake.snapshot()), JSON.parse(before), `${label}: exakt wiederhergestellt`);
}
const prodVals = (sku: string) => fake.products.find(p => p.sku === sku)!.vals;

test('Adapter: verfügbar, Verbindungstest, Werkzeugnamen = Werkzeuge, Kern-Features, Prompt, Einstellungen', async () => {
  assert.equal(PLATFORM_SETTINGS.openmage.available, true);
  assert.deepEqual(PLATFORM_SETTINGS.openmage.auth.map(a => a.fields.map(f => f.key)), [['token']]);
  assert.equal(s.platform, 'openmage');
  assert.deepEqual(tools.map(t => t.name), toolNamesFor('openmage'));
  for (const n of ['search_products', 'get_product', 'list_products', 'search_categories', 'get_category', 'search_media', 'list_cms_pages', 'get_cms_page', 'read_page', 'get_seo_urls', 'list_store_views', 'get_variants', 'list_promotions', 'list_product_attributes', 'propose_product_changes', 'propose_new_products', 'propose_product_images', 'propose_alt_texts', 'propose_category_changes', 'propose_category_products', 'propose_translations', 'propose_variants', 'propose_promotion', 'propose_promotion_status', 'propose_seo_urls', 'preview_bulk_filter', 'propose_bulk_product_change', 'propose_cms_page_changes', 'propose_import', 'draft_page', 'publish_page', 'run_shop_check'])
    assert.ok(toolNamesFor('openmage').includes(n), n);
  const t = await openmage.testConnection();
  assert.equal(t.ok, true, t.message); assert.match(t.message, /Verbunden mit Haus Holm \(OpenMage 20\.18\.0, Modul 1\.2\.0\): Store-View Deutsch \(default, de_DE, EUR\), 4 Produkte, Preise brutto/);
  assert.equal((await openmage.health()).ok, true);
  const u = await openmage.urls();
  assert.equal(u.storefront, fake.base); assert.match(u.admin, /\/index\.php\/admin$/);
  const p = buildBasePrompt('openmage');
  assert.doesNotMatch(p, /\{\{\w+\}\}|Shopware|Einkaufswelt|noch nicht verfügbar|mg-/); assert.equal((p.match(/Page Builder/g) ?? []).length, 1, 'Page Builder nur als Abgrenzung zu Magento 2');
  assert.match(p, /## Preise in OpenMage \(Streichpreis\)/); assert.match(p, /## So funktionieren Seiten in OpenMage/); assert.match(p, /Lotse_Connector/); assert.match(p, /seo_audit, find_image_gaps/);
  for (const line of p.split('\n').filter(l => /OpenMage/.test(l))) assert.doesNotMatch(line, /—/);
});

test('Lese-Werkzeuge: Format, Preise, Bilder, Varianten, Kategorien, Promotionen ohne Kundendaten, Store-Views', async () => {
  const sv = await call('list_store_views');
  assert.equal(sv.priceBasis, 'brutto'); assert.deepEqual(sv.storeViews.map((v: { code: string; isDefault: boolean }) => [v.code, v.isDefault]), [['default', true], ['en', false]]);
  const sp = await call('search_products', { term: 'Ki' });
  assert.equal(sp.total, 1); assert.equal(sp.products[0].number, 'KISSEN'); assert.equal(sp.products[0].price, null, 'Preis aus Varianten');
  const gp = await call('get_product', { id: '2' });
  assert.equal(gp.price, '15,00 €'); assert.equal(gp.listPrice, '18,00 €'); assert.equal(gp.priceDetails.specialActive, true); assert.equal(gp.stock.quantity, 5);
  const vase = await call('get_product', { id: 'VASE' });
  assert.equal(vase.images[0].mediaId, 'om-1-1'); assert.equal(vase.images[0].cover, true); assert.equal(vase.images[1].altMissing, true);
  assert.match(vase.images[0].url, /\/media\/catalog\/product\/v\/a\/vase\.jpg$/);
  assert.ok(!JSON.stringify(vase).includes('einkauf@holm.test'));
  assert.deepEqual(vase.categories.map((c: { id: string; name: string }) => [c.id, c.name]), [['3', 'Wohnaccessoires']]);
  const lp = await call('list_products', { limit: 2 });
  assert.equal(lp.total, 3, 'Einzelprodukt der Variante ausgeblendet'); assert.equal(lp.nextOffset, 2); assert.equal(lp.products[0].stock, 10); assert.equal(lp.products[0].hasMetaTitle, true);
  const cat = await call('get_category', { id: '3' });
  assert.equal(cat.url, `${fake.base}/wohnaccessoires.html`); assert.equal(cat.productCount, 1); assert.equal(cat.displayMode, 'PRODUCTS');
  const cats = await call('search_categories', {});
  assert.deepEqual(cats.map((c: { id: string }) => c.id), ['3', '4']);
  const v = await call('get_variants', { id: 'KISSEN' });
  assert.deepEqual(v.axes, [{ code: 'color', label: 'Farbe', values: ['Sand'], available: ['Salbei'] }]); assert.equal(v.variants[0].price, '39,00 €');
  const promos = await call('list_promotions', {});
  assert.equal(promos.promotions[0].code.code, 'WILLKOMMEN10'); assert.equal(promos.promotions[0].status, 'läuft');
  const detail = await call('get_promotion', { id: '2' });
  assert.match(detail.discount, /15 % auf Kategorien Wohnaccessoires \(inkl\. Versand\)/); assert.equal(detail.otherCartConditions, 1);
  const audit = await call('seo_audit', { entity: 'product' });
  assert.ok(audit.issues.some((i: { issue: string }) => i.issue === 'Meta-Description fehlt'));
  const media = await call('search_media', { term: 'Vase' });
  assert.equal(media[0].mediaId, 'om-1-1');
  const urls = await call('get_seo_urls', { entity: 'product', ids: ['1', 'KISSEN-SAND'] });
  assert.equal(urls[0].url, `${fake.base}/vase.html`); assert.equal(urls[1].url, null, 'nicht sichtbar = keine URL');
  const attrs = await call('list_product_attributes', {});
  assert.ok(attrs.some((a: { code: string; values: string[] }) => a.code === 'color' && a.values.includes('Salbei')));
  assert.ok(accessList(50).some(a => a.chat === 'chat-openmage' && a.entity === 'product'));
});

test('Lookup (Wissensbasis, Search Console, view_image), Vorschau-Daten und Kontext-Auswahl', async () => {
  assert.deepEqual(await s.lookup.findProducts({ ids: ['1'], numbers: ['BECHER'] }), [{ id: '1', number: 'VASE', name: 'Vase' }, { id: '2', number: 'BECHER', name: 'Becher' }]);
  assert.deepEqual((await s.lookup.getProduct('1'))?.categoryIds, ['2', '3']);
  assert.match(String(await s.lookup.mediaUrl('om-1-2')), /vase-2\.jpg$/);
  const mu = await s.lookup.mapUrls([`${fake.base}/vase.html`, `${fake.base}/wohnaccessoires.html`, `${fake.base}/`, `${fake.base}/no-route`, 'https://fremd.test/vase.html'], { metas: true });
  assert.deepEqual(mu.get(`${fake.base}/vase.html`), { kind: 'product', id: '1', name: 'Vase', number: 'VASE', active: true, metaTitle: 'Vase | Holm', metaDescription: null });
  assert.equal(mu.get(`${fake.base}/wohnaccessoires.html`)?.kind, 'category'); assert.equal(mu.get(`${fake.base}/no-route`)?.kind, 'landing');
  assert.deepEqual(mu.get(`${fake.base}/`), { kind: 'home' }); assert.equal(mu.get('https://fremd.test/vase.html'), null);
  assert.deepEqual(await s.lookup.entityPaths('product', '1'), { paths: ['vase.html'], urls: [`${fake.base}/vase.html`] });
  assert.equal((await s.lookup.current('category', '3'))?.name, 'Wohnaccessoires');
  const ctx = await openmage.pages.previewData(s, { name: 'x', type: 'product_list', previewCategoryId: '3', sections: [{ blocks: [{ type: 'product-slider', productIds: ['BECHER'] }, { type: 'image-cover', image: { mediaId: 'om-1-1', alt: 'x' } }] }] });
  assert.equal(ctx.products?.BECHER?.price, '15,00 €'); assert.equal(ctx.products?.['1']?.name, 'Vase'); assert.equal(ctx.products?.['1']?.url, `${fake.base}/vase.html`);
  assert.match(String(ctx.imageUrl?.({ mediaId: 'om-1-1' })), /vase\.jpg$/);
  const cats = await openmage.context.categories();
  assert.deepEqual(cats.map(c => [c.id, c.parentId]), [['2', null], ['3', '2'], ['4', '2']]);
  assert.deepEqual((await openmage.context.products({ term: 'Vas' })).map(p => p.number), ['VASE']);
});

test('Produkte: Texte (global bzw. Store-View mit eigenem Wert), Preis mit Streichpreis, Bestand, Status, Attribut – Rückgängig exakt', async () => {
  prodVals('VASE')[1] = { meta_description: 'Eigene MD default' };
  await roundtrip('Produkt', () => call('propose_product_changes', { title: 'Test', reason: 'Test', changes: [{ id: '1', fields: { name: 'Vase neu', metaDescription: 'Neue MD', description: '<p>neu</p>', active: false, stock: 7, price: { percent: -10, round: '.99' }, listPrice: 49, attributes: { color: 'Salbei' } } }] }), () => {
    const v = prodVals('VASE');
    assert.equal(v[0].name, 'Vase neu', 'geerbt → global'); assert.equal(v[1].meta_description, 'Neue MD', 'eigener Wert → Store-View'); assert.notEqual(v[0].meta_description, 'Neue MD');
    assert.equal(v[0].price, 49); assert.equal(v[0].special_price, 43.99); assert.equal(v[0].status, 2); assert.equal(v[0].color, 4);
    assert.equal(fake.products.find(x => x.sku === 'VASE')!.stock.qty, 7);
    assert.ok(lastCs().cs.items.some(i => i.id === 'info:preis'), 'Hinweis zur Preislogik');
  });
  delete prodVals('VASE')[1];
  const bad = await call('propose_product_changes', { title: 'x', reason: 'x', changes: [{ id: 'KISSEN', fields: { price: 10 } }, { id: 'VASE', fields: { foo: 1, listPrice: 20 } }] });
  assert.match(bad.error, /Keine Änderung nötig bzw\. nichts anwendbar/); assert.match(bad.error, /Einzelprodukten/);
});

test('Andere Store-View als die Haupt-View: geerbte Texte werden dort gespeichert, nicht global; Rückgängig = wieder erben', async () => {
  const { reg, undoOpenmage } = await import('./write');
  const before = fake.snapshot(), c = new OmClient({ url: fake.base, token: fake.token, storeCode: 'en' });
  const cs = { id: 'cs-en', kind: 'products', entity: 'product', title: 't', reason: null, skipped: [], atomic: false, items: [{ id: '1:name', entity: 'product', entityId: '1', label: 'Vase', field: 'name', fieldLabel: 'Name', before: 'Vase', after: 'Vase EN', afterRaw: 'Vase EN', warn: [] }] };
  const partial: { done: number; total: number; undo: number }[] = [];
  const r = await reg.apply(c, cs, { store: 'en', skus: { 1: 'VASE' } }, new Set(['1:name']), { progress: (done, total, p) => partial.push({ done, total, undo: p?.undo.length ?? -1 }) });
  assert.ok(r.results[0].ok, JSON.stringify(r));
  assert.deepEqual(partial, [{ done: 1, total: 1, undo: r.undo.length }], 'applyGrouped meldet den Zwischenstand je Datensatz (Absturzsicherheit)');
  assert.equal(prodVals('VASE')[2].name, 'Vase EN'); assert.equal(prodVals('VASE')[0].name, 'Vase');
  assert.ok((await undoOpenmage(c, r.undo)).every(x => x.ok));
  assert.equal(fake.snapshot(), before);
});

test('Abgelehnt = nichts geschrieben; Preisänderung zwischen Vorschlag und Freigabe wird erkannt', async () => {
  const before = fake.snapshot();
  allow = false;
  const r = await call('propose_product_changes', { title: 'x', reason: 'x', changes: [{ id: '2', fields: { name: 'Nein' } }] });
  allow = true;
  assert.equal(r.status, 'rejected'); assert.equal(fake.snapshot(), before);
  const orig = s.emit;
  s.emit = ev => { if (ev.t === 'changeset') prodVals('BECHER')[0].special_price = 14; orig(ev); };
  const r2 = await call('propose_product_changes', { title: 'x', reason: 'x', changes: [{ id: '2', fields: { price: 12 } }] });
  s.emit = orig; prodVals('BECHER')[0].special_price = 15;
  assert.equal(r2.status, 'failed'); assert.match(JSON.stringify(r2.failed), /inzwischen in OpenMage geändert/);
});

test('Kategorien, Zuordnung, URL-Schlüssel (mit Rewrite-Historie), Übersetzungen – Rückgängig exakt', async () => {
  await roundtrip('Kategorie', () => call('propose_category_changes', { title: 'K', reason: 'K', changes: [{ id: '3', fields: { name: 'Wohnen', metaTitle: 'Wohnen | Haus Holm', active: false } }] }), () => { const v = fake.categories.find(c => c.id === 3)!.vals[0]; assert.equal(v.name, 'Wohnen'); assert.equal(v.is_active, false); assert.equal(v.meta_title, 'Wohnen', 'Theme-Suffix „ | Haus Holm“ nicht doppelt (OpenMage hängt es selbst an)'); });
  await roundtrip('Zuordnung', () => call('propose_category_products', { title: 'Z', reason: 'Z', categoryId: '3', add: [{ productId: '2', position: 2 }], remove: ['VASE'] }), () => {
    assert.deepEqual(fake.products.find(p => p.sku === 'BECHER')!.categories, [{ id: 3, position: 2 }, { id: 4, position: 1 }]); assert.deepEqual(fake.products.find(p => p.sku === 'VASE')!.categories, []);
  });
  await roundtrip('URL-Schlüssel', () => call('propose_seo_urls', { title: 'U', reason: 'U', entity: 'product', changes: [{ id: '1', urlKey: 'Vase Kiesel Steinzeug' }] }), () => {
    assert.equal(prodVals('VASE')[0].url_key, 'vase-kiesel-steinzeug');
    assert.ok(fake.rewrites.some(r => r.request_path === 'vase.html' && r.options === 'RP' && r.target_path === 'vase-kiesel-steinzeug.html'), '301 von der alten URL');
    assert.ok(lastResult().undo?.some(u => /\/v1\/urlrewrites\/\d+$/.test(String(u.path)) && u.method === 'DELETE'), 'Rückgängig löscht die Rewrites');
  });
  const dup = await call('propose_seo_urls', { title: 'U', reason: 'U', entity: 'product', changes: [{ id: '1', urlKey: 'becher' }] });
  assert.match(dup.error, /schon vergeben/);
  // Kategorie: OpenMage legt auch hier History-Rewrites an (beim Ändern UND beim Zurücksetzen); Rückgängig lässt keine zurück
  await roundtrip('URL-Schlüssel Kategorie', () => call('propose_seo_urls', { title: 'U', reason: 'U', entity: 'category', changes: [{ id: '4', urlKey: 'kueche-tisch' }] }), () => {
    assert.equal(fake.categories.find(c => c.id === 4)!.vals[0].url_key, 'kueche-tisch');
    assert.ok(fake.rewrites.some(r => r.request_path === 'kueche.html' && r.options === 'RP' && r.category_id === 4 && r.target_path === 'kueche-tisch.html'), '301 von der alten Kategorie-URL');
    assert.ok(lastResult().undo?.some(u => /\/v1\/urlrewrites\/\d+$/.test(String(u.path)) && u.method === 'DELETE'), 'Rückgängig löscht die Rewrites der Kategorie');
    assert.match(String(lastCs().cs.items.find(i => i.id === 'info:undo')?.after), /löscht die dabei angelegte Weiterleitung/);
  });
  assert.ok(!fake.rewrites.some(r => r.category_id === 4 && !r.is_system), 'nach Rückgängig keine History-Rewrites der Kategorie (auch nicht die des Zurücksetzens)');
  await roundtrip('Übersetzung Produkt', () => call('propose_translations', { title: 'EN', reason: 'EN', entity: 'product', changes: [{ id: 'VASE', store: 'en_US', fields: { name: 'Vase (EN)', metaTitle: 'Vase EN – Haus Holm' } }] }), () => {
    assert.equal(prodVals('VASE')[2].name, 'Vase (EN)'); assert.equal(prodVals('VASE')[0].name, 'Vase'); assert.equal(prodVals('VASE')[2].meta_title, 'Vase EN', 'Theme-Suffix auch in der Übersetzung entfernt');
  });
  await roundtrip('Übersetzung Kategorie', () => call('propose_translations', { title: 'EN', reason: 'EN', entity: 'category', changes: [{ id: '3', store: 'en', fields: { name: 'Home accessories', description: '<p>Home</p>' } }] }), () => assert.equal(fake.categories.find(c => c.id === 3)!.vals[2].name, 'Home accessories'));
  const tr = await call('get_translations', { entity: 'product', ids: ['1'] });
  assert.equal(tr[0].storeViews.en.name.own, false);
});

test('Bilder (neu als Titelbild, ausblenden, sortieren) und Alt-Texte – Rückgängig exakt', async () => {
  const st = stageImage(png, 'image/png', { name: 'blau', alt: 'Blaue Vase' });
  await roundtrip('Bilder', () => call('propose_product_images', { title: 'B', reason: 'B', products: [{ productId: '1', add: [{ image: st.mediaId, cover: true, position: 0 }], remove: ['om-1-1'] }] }), () => {
    const p = fake.products.find(x => x.sku === 'VASE')!;
    assert.equal(p.images.length, 3); assert.equal(p.images.find(m => m.id === 1)!.vals[0].disabled, true);
    assert.match(String(p.vals[0].image), /blau/); assert.match(String(p.vals[0].thumbnail), /blau/);
  });
  const skipped = await call('propose_alt_texts', { title: 'A', reason: 'A', images: [{ mediaId: 'om-1-2', alt: 'Vase von der Seite' }] });
  assert.match(skipped.error, /nicht mit view_image angesehen/);
  s.events.push({ t: 'tool', name: 'mcp__shop__view_image', input: { mediaId: 'om-1-2' } } as unknown as ChatEvent);
  await roundtrip('Alt-Text', () => call('propose_alt_texts', { title: 'A', reason: 'A', images: [{ mediaId: 'om-1-2', alt: 'Vase von der Seite' }] }), () => assert.equal(fake.products[0].images[1].vals[0].label, 'Vase von der Seite'));
  // eigener Store-Text → in der Store-View ändern
  fake.products[0].images[1].vals[1] = { label: 'DE-Label' };
  await roundtrip('Alt-Text Store', () => call('propose_alt_texts', { title: 'A', reason: 'A', images: [{ mediaId: 'om-1-2', alt: 'Seitlich' }] }), () => { assert.equal(fake.products[0].images[1].vals[1].label, 'Seitlich'); assert.equal(fake.products[0].images[1].vals[0].label, ''); });
  delete fake.products[0].images[1].vals[1];
});

test('Store-View mit eigener Galerie-Zeile und eigenen Rollen: Ausblenden und Titelbild greifen auch dort; Rückgängig exakt', async () => {
  const p = fake.products.find(x => x.sku === 'VASE')!;
  // Magento 1 legt bei jedem Store-Save Galerie-Zeilen je View an (disabled fest) und hier zusätzlich eigene Rollen in der View
  p.images[0].vals[1] = { label: 'Vase DE', disabled: false };
  p.vals[1] = { image: '/v/a/vase.jpg', small_image: '/v/a/vase.jpg', thumbnail: '/v/a/vase.jpg' };
  await roundtrip('Ausblenden mit Store-Zeile', () => call('propose_product_images', { title: 'B', reason: 'B', products: [{ productId: '1', remove: ['om-1-1'] }] }), () => {
    assert.equal(p.images[0].vals[0].disabled, true); assert.equal(p.images[0].vals[1].disabled, true, 'in der View ausgeblendet');
    assert.equal(p.images[0].vals[1].label, 'Vase DE');
    assert.equal(p.vals[0].image, '/v/a/vase-2.jpg'); assert.equal(p.vals[1].image, '/v/a/vase-2.jpg', 'Titelbild-Rolle auch in der View');
    assert.equal(p.vals[1].thumbnail, '/v/a/vase-2.jpg');
  });
  // nur eigene Rollen in der View (keine Galerie-Zeile): Titelbild-Wechsel greift auch dort, globale Rolle unverändert
  delete p.images[0].vals[1];
  await roundtrip('Titelbild mit eigenen Rollen in der View', () => call('propose_product_images', { title: 'B', reason: 'B', products: [{ productId: '1', cover: 'om-1-2' }] }), () => { assert.equal(p.vals[1].image, '/v/a/vase-2.jpg'); assert.equal(p.vals[0].small_image, '/v/a/vase-2.jpg'); });
  delete p.vals[1];
});

test('Neue Produkte: angelegt inaktiv mit Bestand, Kategorie und Bild; Rückgängig löscht sie', async () => {
  const st = stageImage(png, 'image/png', { name: 'gelb', alt: 'Gelb' });
  const noPrice = await call('propose_new_products', { title: 'N', reason: 'N', products: [{ name: 'Teller', description: '<p>Teller</p>' }] });
  assert.match(noPrice.error, /Preis fehlt/);
  await roundtrip('Neues Produkt', () => call('propose_new_products', { title: 'N', reason: 'N', products: [{ name: 'Teller Ufer', description: '<p>Teller</p>', price: 24, sku: 'TELLER', stock: 4, categoryIds: ['4'], images: [st.mediaId] }] }), () => {
    const p = fake.products.find(x => x.sku === 'TELLER')!;
    assert.equal(p.vals[0].status, 2); assert.equal(p.vals[0].tax_class_id, 2); assert.equal(p.images.length, 1); assert.match(String(p.vals[0].image), /teller-ufer/);
    assert.equal(p.stock.qty, 4); assert.deepEqual(p.categories, [{ id: 4, position: 0 }]);
  });
});

test('Varianten: Preis, Bestand, Status der Einzelprodukte – Rückgängig exakt', async () => {
  await roundtrip('Variante', () => call('propose_variants', { title: 'V', reason: 'V', productId: 'KISSEN', changes: [{ options: { Farbe: 'Sand' }, price: { percent: 10 }, stock: 9, active: false }] }), () => {
    const kid = fake.products.find(x => x.sku === 'KISSEN-SAND')!;
    assert.equal(kid.vals[0].price, 42.9); assert.equal(kid.stock.qty, 9); assert.equal(kid.vals[0].status, 2);
  });
  assert.match((await call('propose_variants', { title: 'V', reason: 'V', productId: 'VASE', changes: [{ sku: 'X', stock: 1 }] })).error, /konfigurierbare/);
});

test('Stapel: Regel auf Filter, Fortschritt, Rückgängig exakt', async () => {
  const prog: unknown[] = [];
  const emit = s.emit; s.emit = ev => { if (ev.t === 'changeset_progress') prog.push(ev); emit(ev); };
  const pv = await call('preview_bulk_filter', { categoryId: '3' });
  assert.equal(pv.matched, 1);
  await roundtrip('Stapel', () => call('propose_bulk_product_change', { title: 'S', reason: 'S', filter: { categoryId: '3' }, change: { price: { percent: -20, round: '.99' }, listPrice: 'currentPrice' } }), () => {
    assert.equal(prodVals('VASE')[0].price, 49); assert.equal(prodVals('VASE')[0].special_price, 38.99);
  });
  s.emit = emit;
  assert.ok(prog.length >= 2);
});

test('Promotionen: anlegen (fester Code), ändern (nur Rabattwert, Mindestbestellwert ergänzt), beenden – Rückgängig exakt', async () => {
  await roundtrip('Promotion neu', () => call('propose_promotion', { reason: 'R', name: 'Herbst', active: true, validFrom: '2026-11-01', validUntil: '2026-11-30', code: { mode: 'fixed', code: 'herbst20' }, discount: { type: 'percentage', value: 20, categoryIds: ['3'] }, minSubtotal: 50, maxUsesPerCustomer: 1 }), () => {
    const r = fake.rules.find(x => x.name === 'Herbst')! as Record<string, unknown>;
    assert.equal(r.coupon_type, 2); assert.equal(r.coupon_code, 'HERBST20'); assert.equal(r.uses_per_customer, 1);
    const conds = (r.conditions as { conditions: { type: string; attribute?: string }[] }).conditions;
    assert.deepEqual(conds.map(c => c.attribute ?? c.type), ['base_subtotal', 'salesrule/rule_condition_product_found']);
    assert.equal((r.actions as { conditions: { value: string }[] }).conditions[0].value, '3');
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rule = () => fake.rules.find(r => r.id === 2)! as Record<string, any>, keep = JSON.parse(JSON.stringify(rule()));
  await roundtrip('Nur Rabatt', () => call('propose_promotion', { id: '2', reason: 'R', discount: { type: 'percentage', value: 20 } }), () => {
    const r = rule(); assert.equal(r.discount_amount, 20);
    for (const k of ['actions', 'conditions', 'apply_to_shipping', 'discount_step', 'discount_qty']) assert.deepEqual(r[k], keep[k], k);
    const it = lastCs().cs.items[0];
    assert.match(it.before, /15 % auf Kategorien Wohnaccessoires \(inkl\. Versand\)/); assert.match(it.after, /20 % auf Kategorien Wohnaccessoires \(inkl\. Versand\)/); assert.match(it.after, /1 weitere Warenkorb-Bedingung/);
  });
  await roundtrip('Mindestbestellwert + Kategorie', () => call('propose_promotion', { id: '2', reason: 'R', minSubtotal: 40, discount: { type: 'percentage', value: 15, categoryIds: ['4'] } }), () => {
    const r = rule();
    assert.deepEqual(r.conditions.conditions.map((c: { attribute?: string; type: string }) => c.attribute ?? c.type), ['country_id', 'base_subtotal', 'salesrule/rule_condition_product_found']);
    assert.equal(r.actions.conditions[0].value, '4'); assert.equal(r.apply_to_shipping, true);
    assert.match(lastCs().cs.items[0].after, /Kategorien Küche.*ab 40,00 € Warenkorb/);
  });
  await roundtrip('Promotion beenden', () => call('propose_promotion_status', { ids: ['1'], action: 'end' }), () => assert.equal(fake.rules[0].is_active, false));
  const taken = await call('propose_promotion', { reason: 'R', name: 'X', active: true, code: { mode: 'fixed', code: 'WILLKOMMEN10' }, discount: { type: 'percentage', value: 5 } });
  assert.match(taken.error, /schon vergeben/);
  const auto = await call('propose_promotion', { reason: 'R', name: 'X', active: true, code: { mode: 'individual' as never, count: 3 }, discount: { type: 'percentage', value: 5 } });
  assert.ok(auto.error, 'Einzelcodes gibt es nicht');
});

test('Suche mit Begriff: Name ODER SKU in EINER Abfrage, Paginierung ohne Lücken und Doppelte, Zählwerte stimmen', async () => {
  // 120 Treffer für „Vase“: 60 nur im Namen, 50 nur in der SKU, 10 in beidem; dazu 5 ohne Treffer
  const extra: FakeProduct[] = [];
  for (let i = 0; i < 125; i++) extra.push(prod(500 + i, i < 50 ? `VASE-${i}` : i < 110 ? `K-${i}` : i < 120 ? `VASE-${i}` : `S-${i}`, { name: i < 50 ? `Krug ${i}` : i < 120 ? `Vase ${i}` : `Schale ${i}`, price: 10 }));
  fake.products.push(...extra);
  try {
    const seen = new Set<string>(); let offset: number | undefined = 0, total = 0, pages = 0;
    while (offset != null) {
      const n = fake.log.length, r = await call('list_products', { term: 'Vase', limit: 50, offset });
      assert.equal(fake.log.slice(n).filter(l => l.path === '/v1/products').length, 1, 'eine Abfrage je Seite');
      total = r.total; pages++;
      for (const p of r.products as { id: string }[]) { assert.ok(!seen.has(p.id), `doppelt: ${p.id}`); seen.add(p.id); }
      offset = r.nextOffset;
    }
    assert.equal(total, 121, 'total = 1 (Vase) + 120 Treffer in Name oder SKU');
    assert.equal(seen.size, 121); assert.equal(pages, 3);
    const sp = await call('search_products', { term: 'VASE-1', limit: 5 });
    assert.equal(sp.total, 21, 'VASE-1, VASE-10…19, VASE-110…119 (SKU-Treffer zählen exakt, auch jenseits von limit)'); assert.equal(sp.products.length, 5);
    assert.deepEqual((await openmage.context.products({ term: 'Krug 1' })).map(p => p.number).slice(0, 2), ['VASE-1', 'VASE-10']);
    assert.equal((await call('preview_bulk_filter', { term: 'Vase' })).matched, 121);
  } finally { fake.products = fake.products.filter(p => !extra.includes(p)); }
});

test('Numerische SKU neben gleicher Entitäts-ID: mehrdeutig statt stilles falsches Produkt; id:/sku: sind eindeutig', async () => {
  const zwei = prod(50, '2', { name: 'Zwei', price: 1 });
  fake.products.push(zwei);
  try {
    assert.match((await call('get_product', { id: '2' })).error, /Mehrdeutig: „2“ ist Produkt-ID \(Becher, SKU BECHER\) und zugleich SKU \(Zwei, ID 50\)/);
    assert.equal((await call('get_product', { id: 'id:2' })).number, 'BECHER'); assert.equal((await call('get_product', { id: 'sku:2' })).name, 'Zwei');
    assert.equal((await call('get_product', { id: '50' })).name, 'Zwei', 'nur ein Treffer (ID): eindeutig');
    assert.match((await call('propose_product_changes', { title: 'x', reason: 'x', changes: [{ id: '2', fields: { name: 'Neu' } }] })).error, /Mehrdeutig/);
    const imgs = await call('get_product_images', { productNumbers: ['sku:2', 'id:2'] });
    assert.deepEqual(imgs.map((x: { id: string }) => x.id), ['50', '2']);
  } finally { fake.products = fake.products.filter(p => p !== zwei); }
});

test('undoOpenmage: umgekehrte Reihenfolge, 404 beim Löschen gilt als erledigt, Rewrites des Zurücksetzens werden gelöscht, unbekannte Art abgelehnt', async () => {
  const { undoOpenmage } = await import('./write');
  const c = new OmClient({ url: fake.base, token: fake.token });
  prodVals('VASE')[0].url_key = 'vase-neu'; // wie nach einem url_key-Schreiben; Rückgängig setzt 'vase' zurück
  const before = fake.snapshot(), n = fake.log.length;
  const r = await undoOpenmage(c, [{ op: 'req', entity: 'cms-block', id: '999', method: 'DELETE', path: '/v1/cms/blocks/999' }, { op: 'req', entity: 'product', id: 'VASE', method: 'PATCH', path: '/v1/products/VASE', body: { attributes: { url_key: 'vase' } } }]);
  assert.deepEqual(r, [{ ok: true }, { ok: true }]);
  const log = fake.log.slice(n).map(l => `${l.method} ${l.path}`);
  assert.equal(log[0], 'PATCH /v1/products/VASE'); assert.match(log[1], /^DELETE \/v1\/urlrewrites\/\d+$/); assert.equal(log.at(-1), 'DELETE /v1/cms/blocks/999');
  assert.equal(prodVals('VASE')[0].url_key, 'vase');
  assert.ok(!fake.rewrites.some(x => x.options === 'RP' && x.product_id === 1), 'keine History-Rewrites des Zurücksetzens übrig');
  assert.notEqual(fake.snapshot(), before); prodVals('VASE')[0].url_key = 'vase';
  const bad = await undoOpenmage(c, [{ op: 'patch', entity: 'product', id: 'VASE', path: '/v1/products/VASE' } as never, { op: 'req', entity: 'x', id: '1', method: 'DELETE', path: '/v1/salesrules/999' }, { op: 'req', entity: 'x', id: '1', method: 'PATCH', path: '/v1/products/GIBTS-NICHT', body: { attributes: {} } }]);
  assert.deepEqual(bad.map(x => x.ok), [false, true, false], 'Ergebnisse in Ausführungsreihenfolge (rückwärts)'); assert.match(String(bad[0].error), /404/); assert.match(String(bad[2].error), /Rückgängig-Art patch wird für OpenMage nicht unterstützt/);
});

test('Rückgängig einer fremden Plattform wird nicht ausgeführt; unbekannte Änderungsart wirft', async () => {
  const { undoWithPlatform } = await import('../index');
  const r = await undoWithPlatform([{ op: 'req', entity: 'product', id: 'VASE', method: 'PATCH', path: '/v1/products/VASE', body: {}, platform: 'magento' }], 'openmage');
  assert.equal(r[0].ok, false);
  await assert.rejects(openmage.apply({ id: 'x', kind: 'gibts-nicht', title: '', reason: null, items: [], skipped: [], atomic: false }, null, new Set()), /keinen Executor/);
});

// Zuletzt: der Fake wird geschlossen
test('health() meldet einen Ausfall trotz gecachter Shop-Info und nach reconfigure wieder ok', async () => {
  assert.equal((await openmage.health()).ok, true);
  await fake.close();
  const down = await openmage.health();
  assert.equal(down.ok, false); assert.match(String(down.error), /nicht erreichbar/);
  const fake2 = await startFakeOpenmage({ products: [prod(1, 'VASE', { name: 'Vase', price: 1 })] });
  const { openmageClient } = await import('./index');
  openmageClient().configure({ url: fake2.base, token: fake2.token });
  assert.equal((await openmage.health()).ok, true);
  await fake2.close();
});

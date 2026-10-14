// Magento: Store-View-/Website-Scope (Preise, Galerie, Alt-Texte, Nachziehpfad), Paginierung der Lese-Werkzeuge,
// Link-Prüfung mit Cache und Rewrites, Stapel-Paginierung, kleine Helfer. Gegen den Fake (fake.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatEvent } from '@/lib/protocol';
import { startFakeMagento, type FakeProduct } from '../../../support/magento-fake';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-magento-scope-'));
const prod = (id: number, sku: string, v: Record<string, unknown>, extra: Partial<FakeProduct> = {}): FakeProduct => ({ id, sku, type_id: 'simple', attribute_set_id: 4, website_ids: [1], media: [], vals: { 0: { status: 1, visibility: 4, url_key: sku.toLowerCase(), ...v } }, ...extra });
const LINKS = '<p>Siehe <a href="/vase.html">Vase</a>, <a href="/wohnaccessoires.html">Wohnen</a> und <a href="/ueber-uns">uns</a></p>';
const fake = await startFakeMagento({
  categories: [
    { id: 2, parent_id: 1, level: 1, path: '1/2', vals: { 0: { name: 'Default Category', is_active: true } }, products: [] },
    { id: 3, parent_id: 2, level: 2, path: '1/2/3', vals: { 0: { name: 'Wohnaccessoires', is_active: true, url_key: 'wohnaccessoires', url_path: 'wohnaccessoires' }, 1: { name: 'Wohnaccessoires' } }, products: [{ sku: 'VASE', position: 0 }] },
    { id: 5, parent_id: 2, level: 2, path: '1/2/5', vals: { 0: { name: 'Alt', is_active: false, url_key: 'alt', url_path: 'alt' } }, products: [] },
  ],
  products: [
    // Website-Preis: Store-View „default“ zeigt 49, global steht 59 (Preis-Scope „Website“)
    prod(1, 'VASE', { name: 'Vase', price: 59, description: `<p>Vase</p>${LINKS}`, image: '/v/a/vase.jpg', small_image: '/v/a/vase.jpg', thumbnail: '/v/a/vase.jpg', swatch_image: 'no_selection' },
      { vals: { 0: { status: 1, visibility: 4, url_key: 'vase', name: 'Vase', price: 59, description: `<p>Vase</p>${LINKS}`, image: '/v/a/vase.jpg', small_image: '/v/a/vase.jpg', thumbnail: '/v/a/vase.jpg', swatch_image: 'no_selection' }, 1: { price: 49 } },
        media: [{ id: 1, file: '/v/a/vase.jpg', media_type: 'image', vals: { 0: { label: 'Vase', position: 1, disabled: false }, 1: { label: 'Vase', position: 1, disabled: false } } }, { id: 2, file: '/v/a/vase-2.jpg', media_type: 'image', vals: { 0: { label: '', position: 2, disabled: false } } }] }),
    // Website-Preis zufällig gleich dem globalen
    prod(2, 'BECHER', { name: 'Becher', price: 49, description: `<p>Becher</p>${LINKS}` }, { vals: { 0: { status: 1, visibility: 4, url_key: 'becher', name: 'Becher', price: 49, description: `<p>Becher</p>${LINKS}` }, 1: { price: 49 } } }),
    prod(3, 'KISSEN-SAND', { name: 'Kissen Sand', price: 39, visibility: 1 }),
    // eigener, gleicher Name in der Store-View (Nachziehpfad von writeScoped)
    prod(4, 'SCHALE', { name: 'Schale', price: 30 }, { vals: { 0: { status: 1, visibility: 4, url_key: 'schale', name: 'Schale', price: 30 }, 1: { name: 'Schale' } } }),
    prod(5, 'SET-1,2', { name: 'Set', price: 20 }),
    ...Array.from({ length: 30 }, (_, i) => prod(10 + i, `NOIMG-${i + 1}`, { name: `Ohne Bild ${i + 1}`, price: i < 3 ? 0 : 10, description: i < 20 ? LINKS : '' })),
  ],
  sourceItems: [{ sku: 'VASE', source_code: 'default', quantity: 10, status: 1 }, { sku: 'SET-1,2', source_code: 'default', quantity: 3, status: 1 }],
  cmsPages: [{ id: 5, identifier: 'ueber-uns', title: 'Über uns', content: `<p>Wir <img src="data:image/svg+xml;base64,${'QUJD'.repeat(60)}"> ${LINKS}</p>`, active: true, store_id: [0] }],
  rewrites: { 'vase-alt': 'vase' },
});
process.env.SHOP_PLATFORM = 'magento';
process.env.MAGENTO_URL = fake.base;
process.env.MAGENTO_ACCESS_TOKEN = fake.token;
process.env.MAGENTO_PRICE_BASIS = 'gross';

const { MagentoClient } = await import('../../../../src/server/platform/magento/client');
const { MagentoReader } = await import('../../../../src/server/platform/magento/reader');
const { reg, undoMagento, mainStoreCode } = await import('../../../../src/server/platform/magento/write');
const { checkMagentoLinks } = await import('../../../../src/server/platform/magento/links');
const { conditionWith, undoLabels } = await import('../../../../src/server/platform/magento/promo');
const { firstH1Text } = await import('../../../../src/server/platform/magento/pages');
const { limitHtml } = await import('../../../../src/server/platform/magento/cms');
const { resolveBulk, bulkChangeSet, scanHint, BULK_SCAN } = await import('../../../../src/server/platform/magento/bulk');
const { magento, magentoReaderFor } = await import('../../../../src/server/platform/magento/index');
const { getSession, decideChange, undoChangeSet } = await import('../../../../src/server/sessions');
const { buildTools } = await import('../../../../src/server/tools');
const { listChecks } = await import('../../../../src/server/checks');
const { runChecks } = await import('../../../../src/server/shopcheck-run');

test.after(() => fake.close());

type Res = { isError?: boolean; content: { text: string }[] };
const s = getSession('chat-magento-scope');
s.emit = ev => { s.events.push(ev); if (ev.t === 'changeset') setTimeout(() => decideChange('chat-magento-scope', ev.approvalId, true), 1); };
const tools = buildTools(s);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => { const r = (await tools.find(t => t.name === name)!.handler(args, {})) as Res; const t = r.content.map(c => c.text).join('\n'); if (r.isError) return { error: t }; try { return JSON.parse(t); } catch { return t; } };
const lastResult = () => [...s.events].reverse().find(e => e.t === 'changeset_result') as Extract<ChatEvent, { t: 'changeset_result' }>;
const prodVals = (sku: string) => fake.products.find(p => p.sku === sku)!.vals;
const client = (storeCode?: string) => new MagentoClient({ url: fake.base, accessToken: fake.token, storeCode, priceBasis: 'gross' });
const reader = (storeCode?: string) => new MagentoReader(client(storeCode));

// ================= Lese-Werkzeuge: Paginierung =================
test('find_image_gaps: Seitengröße = limit, alle Treffer der Seite, über nextOffset kommen alle Produkte ohne Bild', async () => {
  const ids = new Set<string>(); let offset: number | undefined = 0, calls = 0;
  while (offset != null) {
    const r = await call('find_image_gaps', { missing: 'images', active: true, limit: 10, offset }); calls++;
    assert.equal(r.products.length, r.found, 'kein Treffer zwischen Limit und Seite verloren'); assert.ok(r.scanned <= 10);
    for (const p of r.products) ids.add(p.id);
    offset = r.nextOffset;
  }
  const want = fake.products.filter(p => !p.media.length && p.vals[0].visibility !== 1 && p.vals[0].status === 1).map(p => String(p.id));
  assert.deepEqual([...ids].sort(), want.sort()); assert.equal(ids.size, 33); assert.ok(calls >= 4);
});

test('list_products: Preisspanne serverseitig vorgefiltert, je Seite genau geprüft, Hinweis auf total/returned', async () => {
  const r = await call('list_products', { active: true, maxPrice: 0, limit: 1 });
  assert.equal(r.total, 3, 'Serverfilter: nur Produkte mit Preis ≤ 0'); assert.equal(r.returned, 1); assert.equal(r.nextOffset, 1); assert.match(r.note, /je Seite/);
  const all: string[] = []; let offset: number | undefined = 0;
  while (offset != null) { const x = await call('list_products', { active: true, maxPrice: 0, limit: 1, offset }); all.push(...x.products.map((p: { number: string }) => p.number)); offset = x.nextOffset; }
  assert.deepEqual(all, ['NOIMG-1', 'NOIMG-2', 'NOIMG-3']);
  const hi = await call('list_products', { minPrice: 40 });
  assert.deepEqual(hi.products.map((p: { number: string }) => p.number).sort(), ['BECHER', 'VASE'], 'Store-View-Preis 49 der Vase zählt');
  assert.equal((await call('list_products', { limit: 5 })).note, undefined, 'ohne Preis-/Bestandsfilter kein Hinweis');
});

// ================= Preise im Scope des Vorschlags =================
test('Preis: Prüfung in der Store-View des Vorschlags; Website-Preis verdeckt den globalen Wert → Fehler mit Rückgängig statt Erfolg', async () => {
  const before = fake.snapshot();
  const r = await call('propose_product_changes', { title: 'P', reason: 'P', changes: [{ id: 'VASE', fields: { price: 45 } }] });
  const cs = [...s.events].reverse().find(e => e.t === 'changeset') as Extract<ChatEvent, { t: 'changeset' }>;
  assert.equal(cs.cs.items.find(i => i.field === 'price')!.before, '49,00 € brutto', 'Vorschlag rechnet mit dem Preis der Store-View');
  assert.notEqual(r.status, 'applied'); assert.match(r.failed[0].error, /Website-Preis/); assert.doesNotMatch(r.failed[0].error, /inzwischen/);
  assert.equal(prodVals('VASE')[0].price, 45, 'global geschrieben'); assert.equal(prodVals('VASE')[1].price, 49, 'View zeigt weiter den Website-Preis');
  assert.ok((await undoChangeSet('chat-magento-scope', lastResult().csId))?.ok, 'Rückgängig-Schritte hängen am Fehler');
  assert.equal(fake.snapshot(), before);
  // Website-Preis zufällig gleich dem globalen: früher stiller Erfolg ohne Wirkung in der Storefront
  const r2 = await call('propose_product_changes', { title: 'P', reason: 'P', changes: [{ id: 'BECHER', fields: { price: 45 } }] });
  assert.notEqual(r2.status, 'applied'); assert.match(r2.failed[0].error, /Website-Preis/);
  assert.ok((await undoChangeSet('chat-magento-scope', lastResult().csId))?.ok); assert.equal(fake.snapshot(), before);
  // ohne Website-Preis (Preis-Scope global): wie bisher
  const ok = await call('propose_product_changes', { title: 'P', reason: 'P', changes: [{ id: 'SCHALE', fields: { price: 27 } }] });
  assert.equal(ok.status, 'applied'); assert.equal(prodVals('SCHALE')[0].price, 27);
  assert.ok((await undoChangeSet('chat-magento-scope', lastResult().csId))?.ok); assert.equal(fake.snapshot(), before);
});

test('Stapel und Import prüfen den Preis ebenfalls in der Store-View (kein falsches „inzwischen geändert“)', async () => {
  const before = fake.snapshot();
  const r = await call('propose_bulk_product_change', { title: 'S', reason: 'S', filter: { skus: ['VASE', 'SCHALE'] }, change: { price: { percent: -10 } } });
  assert.equal(r.failedTotal, 1, 'Vase: Website-Preis, Schale: geschrieben'); assert.match(JSON.stringify(r.failed), /Website-Preis/);
  assert.equal(prodVals('SCHALE')[0].price, 27);
  assert.ok((await undoChangeSet('chat-magento-scope', lastResult().csId))?.ok); assert.equal(fake.snapshot(), before);
});

// ================= Galerie und Alt-Texte je Store-View =================
test('Galerie: Store-View mit eigenen Galeriewerten wird nachgezogen (Position, Sichtbarkeit), Rückgängig exakt', async () => {
  const before = fake.snapshot();
  const r = await call('propose_product_images', { title: 'B', reason: 'B', products: [{ productId: '1', remove: ['mg-1-1'] }] });
  assert.equal(r.status, 'applied', JSON.stringify(r));
  const m1 = fake.products[0].media.find(m => m.id === 1)!;
  assert.deepEqual(m1.vals[0], { label: 'Vase', position: 2, disabled: true }); assert.deepEqual(m1.vals[1], { label: 'Vase', position: 2, disabled: true }, 'eigene Galeriewerte der View nachgezogen');
  assert.ok(fake.log.some(l => l.method === 'PUT' && l.store === 'default' && l.path === '/products/VASE/media/1'));
  const imgs = await call('get_product_images', { productIds: ['1'] });
  assert.equal(imgs[0].images.find((i: { mediaId: string }) => i.mediaId === 'mg-1-1').hidden, true, 'Storefront-Sicht (Store-View) zeigt das Bild ausgeblendet');
  assert.equal(imgs[0].images.find((i: { mediaId: string }) => i.mediaId === 'mg-1-2').cover, true);
  assert.ok((await undoChangeSet('chat-magento-scope', lastResult().csId))?.ok);
  assert.deepEqual(JSON.parse(fake.snapshot()), JSON.parse(before));
});

test('Alt-Text in einer anderen Store-View als der Haupt-View: nur dort schreiben, nie global', async () => {
  const c = client('en'), m1 = () => fake.products[0].media.find(m => m.id === 1)!;
  assert.equal(await mainStoreCode(c), 'default', 'Haupt-View = Standard-View der Website der eingestellten View');
  const cs = { id: 'cs-alt', kind: 'media-alt', entity: 'media', title: 't', reason: null, skipped: [], atomic: false, items: [{ id: 'mg-1-1', entity: 'media', entityId: 'mg-1-1', label: 'Vase', field: 'alt', fieldLabel: 'Alt-Text', before: 'Vase', after: 'Blue vase', afterRaw: 'Blue vase', warn: [] }] };
  const n = fake.log.length, r = await reg.apply(c, cs, { skus: { 'mg-1-1': 'VASE' }, store: 'en' }, new Set(['mg-1-1']));
  assert.ok(r.results[0].ok, JSON.stringify(r));
  assert.deepEqual(fake.log.slice(n).filter(l => l.method === 'PUT').map(l => l.store), ['en'], 'nicht global geschrieben');
  assert.equal(m1().vals[0].label, 'Vase'); assert.equal(m1().vals[2]?.label, 'Blue vase');
  assert.ok((await undoMagento(c, r.undo)).every(x => x.ok));
  assert.equal(m1().vals[2]?.label, 'Vase', 'View zeigt wieder den geerbten Text (als eigener Wert: REST kennt kein „Standardwert verwenden“ für Galeriewerte)');
  delete m1().vals[2];
});

// ================= writeScoped: Nachziehpfad und Kategorie-Rückgängig =================
test('writeScoped: View mit eigenem, gleichem Wert bekommt den neuen Wert nachgezogen; Rückgängig stellt beide Ebenen exakt her', async () => {
  const before = fake.snapshot();
  const r = await call('propose_product_changes', { title: 'N', reason: 'N', changes: [{ id: 'SCHALE', fields: { name: 'Schale neu' } }] });
  assert.equal(r.status, 'applied');
  assert.equal(prodVals('SCHALE')[0].name, 'Schale neu', 'geerbt laut Vergleich → global'); assert.equal(prodVals('SCHALE')[1].name, 'Schale neu', 'eigener gleicher Wert der View nachgezogen');
  assert.ok((await undoChangeSet('chat-magento-scope', lastResult().csId))?.ok);
  assert.deepEqual(JSON.parse(fake.snapshot()), JSON.parse(before));
  // Kategorie: name der View lässt sich nicht auf null setzen → Rückgängig schreibt den globalen Namen in die View (fixCategoryUndo)
  const k = await call('propose_category_changes', { title: 'K', reason: 'K', changes: [{ id: '3', fields: { name: 'Wohnen' } }] });
  assert.equal(k.status, 'applied');
  const cat = fake.categories.find(c => c.id === 3)!;
  assert.equal(cat.vals[0].name, 'Wohnen'); assert.equal(cat.vals[1].name, 'Wohnen');
  assert.ok((await undoChangeSet('chat-magento-scope', lastResult().csId))?.ok);
  assert.deepEqual(cat.vals[1], { name: 'Wohnaccessoires' }); assert.deepEqual(JSON.parse(fake.snapshot()), JSON.parse(before));
});

// ================= Links =================
test('checkMagentoLinks: Weiterleitung mit Rewrite (relativ und absolut), unsichtbares Produkt, inaktive Kategorie, MAX_LINKS', async () => {
  const ro = reader();
  const many = Array.from({ length: 250 }, (_, i) => ({ href: `/weg-${i}.html`, text: `w${i}` }));
  const r = await checkMagentoLinks(ro, [{ href: '/vase-alt.html', text: 'alt' }, { href: `${fake.base}/vase-alt.html`, text: 'abs' }, { href: '/kissen-sand.html', text: 'k' }, { href: '/alt.html', text: 'a' }, { href: '/vase.html', text: 'ok' }, ...many]);
  const by = (href: string) => r.report.findings.find(f => f.href === href)!;
  assert.equal(by('/vase-alt.html').level, 'empfohlen'); assert.match(by('/vase-alt.html').problem, /Weiterleitung \(301\) auf \/vase\.html, besser direkt/);
  assert.equal(r.report.rewrites.get('/vase-alt.html'), '/vase.html'); assert.equal(r.report.rewrites.get(`${fake.base}/vase-alt.html`), `${fake.base}/vase.html`);
  assert.equal(by('/kissen-sand.html').problem, 'Produkt ist nicht einzeln sichtbar'); assert.equal(by('/kissen-sand.html').level, 'wichtig');
  assert.equal(by('/alt.html').problem, 'Kategorie ist inaktiv');
  assert.equal(by('/vase.html'), undefined); assert.equal(r.checked, 200, 'Kappung'); assert.equal(r.report.internal, 255);
  // Entwurf: Link auf die alte URL wird umgeschrieben
  const d = await magento.pages.prepareDraft!(s, { name: 'x', type: 'landingpage', sections: [{ blocks: [{ type: 'text', html: '<p><a href="/vase-alt.html">Vase</a></p>' }] }] });
  assert.match(JSON.stringify(d.spec), /\/vase\.html/); assert.doesNotMatch(JSON.stringify(d.spec), /vase-alt/);
});

test('Shop-Check Links: gemeinsamer Cache je Durchlauf, jeder Pfad wird nur einmal aufgelöst', async () => {
  await magento.loadChecks();
  const checks = listChecks('magento').filter(c => c.id === 'magento.description-links' || c.id === 'magento.cms-links');
  assert.equal(checks.length, 2);
  const n = fake.log.length, ro = magentoReaderFor('shop-check-scope');
  const run = await runChecks(ro as never, checks, { perRun: false, ctx: r => ({ platform: 'magento', reader: r, lookup: magento.lookup(r) }) });
  assert.deepEqual(run.errors, []);
  const routes = fake.log.slice(n).filter(l => l.path === '/graphql' && /route\(/.test(String((l.body as { query?: string })?.query ?? '')));
  assert.equal(routes.length, 3, '22 Produkte + 1 CMS-Seite mit denselben 3 Links: 3 Auflösungen');
  assert.equal(fake.log.slice(n).filter(l => l.path === '/products/VASE' && l.method === 'GET').length, 1);
});

// ================= Helfer =================
test('SKU mit Komma: einzeln gelesen (in-Filter trennt am Komma), Bestand ebenso', async () => {
  const ro = reader();
  assert.deepEqual((await ro.productsBySkus(['SET-1,2', 'VASE'])).map(p => p.sku).sort(), ['SET-1,2', 'VASE']);
  assert.deepEqual((await ro.sourceItems(['SET-1,2'])).map(x => x.quantity), [3]);
  const r = await call('propose_product_changes', { title: 'x', reason: 'x', changes: [{ id: 'SET-1,2', fields: { name: 'Set neu' } }] });
  assert.equal(r.status, 'applied'); assert.ok((await undoChangeSet('chat-magento-scope', lastResult().csId))?.ok);
});

test('Seitentitel aus der H1: ohne JSON-Escapes, Entities aufgelöst; CMS-HTML begrenzt (data-URIs als Platzhalter)', async () => {
  assert.equal(firstH1Text({ name: 'x', type: 'landingpage', sections: [{ blocks: [{ type: 'text', html: '<p>vorher</p>' }, { type: 'text-hero', html: '<h1 class="a">Vasen\nfür "Zuhause" &amp; Garten</h1>' }] }] }), 'Vasen für "Zuhause" & Garten');
  assert.equal(firstH1Text({ name: 'x', type: 'landingpage', sections: [] }), '');
  const big = limitHtml(`<p>a</p><img src="data:image/svg+xml;base64,${'QUJD'.repeat(2000)}">${'x'.repeat(70_000)}`);
  assert.ok(big.truncated); assert.ok(big.html.length < 61_000); assert.match(big.html, /data:image\/svg\+xml;… \[eingebettet, \d+ KB\]/); assert.doesNotMatch(big.html, /QUJDQUJD/);
  assert.deepEqual(limitHtml('<p>klein</p>'), { html: '<p>klein</p>', truncated: false });
  const pg = await call('get_cms_page', { id: 'ueber-uns' });
  assert.match(pg.html, /\[eingebettet, 1 KB\]/); assert.equal(pg.truncated, undefined);
});

test('Promotion-Helfer: Mindestbestellwert ersetzt bzw. ergänzt Bedingungen je aggregator, undoLabels für neue Store-Labels', () => {
  const land = { condition_type: 'Magento\\SalesRule\\Model\\Rule\\Condition\\Address', attribute_name: 'country_id', operator: '==', value: 'DE' };
  const any = conditionWith({ condition: { aggregator_type: 'any', value: '1', conditions: [land] } }, 40);
  assert.equal(any.dropped, 1); assert.deepEqual(any.cond.conditions.map((c: { attribute_name: string }) => c.attribute_name), ['base_subtotal']);
  const allFalse = conditionWith({ condition: { aggregator_type: 'all', value: '0', conditions: [land] } }, 40);
  assert.equal(allFalse.dropped, 1);
  const all = conditionWith({ condition: { aggregator_type: 'all', value: '1', conditions: [land, { attribute_name: 'base_subtotal', operator: '>=', value: '10' }] } }, 40);
  assert.equal(all.dropped, 0); assert.deepEqual(all.cond.conditions.map((c: { attribute_name: string; value: string }) => [c.attribute_name, c.value]), [['country_id', 'DE'], ['base_subtotal', '40']]);
  const none = conditionWith(null, 25);
  assert.equal(none.dropped, 0); assert.equal(none.cond.conditions[0].value, '25'); assert.deepEqual(conditionWith(null, null).cond.conditions, []);
  assert.deepEqual(undoLabels([], [{ store_id: 1, store_label: 'Neu' }]), [{ store_id: 1, store_label: '' }]);
  assert.deepEqual(undoLabels([{ store_id: 0, store_label: 'Alt' }], [{ store_id: 0, store_label: 'Neu' }, { store_id: 2, store_label: 'EN' }]), [{ store_id: 0, store_label: 'Alt' }, { store_id: 2, store_label: '' }]);
});

test('Stapel: mehrseitiges Lesen ohne Dubletten, Abbruch bei BULK_SCAN mit Hinweis, Streichpreis = bisheriger Preis', async () => {
  const big = await startFakeMagento({ products: Array.from({ length: BULK_SCAN + 1 }, (_, i) => prod(i + 1, `P-${i + 1}`, { name: `P ${i + 1}`, price: 10 + (i % 7) })) });
  try {
    const ro = new MagentoReader(new MagentoClient({ url: big.base, accessToken: big.token }));
    const r = await resolveBulk(ro, { maxPrice: 12 });
    assert.equal(r.scanned, BULK_SCAN); assert.equal(r.total, BULK_SCAN + 1);
    assert.equal(new Set(r.rows.map(p => p.id)).size, r.rows.length, 'keine Dubletten'); assert.ok(r.rows.every(p => Number(p.price) <= 12));
    assert.match(scanHint(r.scanned, r.total)[0], /Nur die ersten 10\.000 von 10\.001/); assert.deepEqual(scanHint(5, 5), []);
    assert.equal(big.log.filter(l => l.path === '/products').length, BULK_SCAN / 200, 'Seiten à 200, letzte Seite nicht doppelt');
  } finally { await big.close(); }
  const { payload } = bulkChangeSet('t', 'r', { price: { percent: -10 }, listPrice: 'currentPrice' }, [{ id: 1, sku: 'A', type_id: 'simple', price: 50, status: 1 }], 'gross');
  assert.deepEqual(payload.plans[0].price?.write, { special_price: 45, special_from_date: null }, 'regulärer Preis 50 bleibt Streichpreis');
});

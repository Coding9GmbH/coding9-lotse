// OpenMage: Seiten (HTML, Veröffentlichen mit exaktem Rückgängig), CMS-Seiten ändern, Link-Prüfung, Shop-Check, Import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatEvent } from '@/lib/protocol';
import { startFakeOpenmage, type FakeProduct } from './fake';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-openmage-pages-'));
const prod = (id: number, sku: string, v: Record<string, unknown>, extra: Partial<FakeProduct> = {}): FakeProduct => ({ id, sku, type_id: 'simple', attribute_set_id: 4, website_ids: [1], images: [], categories: [], stock: { qty: 10, is_in_stock: true, manage_stock: true }, vals: { 0: { status: 1, visibility: 4, url_key: sku.toLowerCase(), tax_class_id: 2, ...v } }, ...extra });
const words = (n: number) => Array.from({ length: n }, (_, i) => `Wort${i}`).join(' ');
const fake = await startFakeOpenmage({
  categories: [
    { id: 1, parent_id: 0, level: 0, path: '1', position: 0, vals: { 0: { name: 'Root Catalog', is_active: true } } },
    { id: 2, parent_id: 1, level: 1, path: '1/2', position: 1, vals: { 0: { name: 'Default Category', is_active: true } } },
    { id: 3, parent_id: 2, level: 2, path: '1/2/3', position: 1, vals: { 0: { name: 'Wohnaccessoires', is_active: true, description: '<p>Wohnen</p>', url_key: 'wohnaccessoires', display_mode: 'PRODUCTS', meta_description: 'x'.repeat(130) } } },
    { id: 4, parent_id: 2, level: 2, path: '1/2/4', position: 2, vals: { 0: { name: 'Küche', is_active: true, url_key: 'kueche', display_mode: 'PRODUCTS' } } },
    { id: 5, parent_id: 2, level: 2, path: '1/2/5', position: 3, vals: { 0: { name: 'Alt', is_active: false, url_key: 'alt' } } },
  ],
  products: [
    prod(1, 'VASE', { name: 'Vase', price: 49, description: `<p>Vase aus Steinzeug. ${words(60)} <a href="/becher.html">Becher</a> <a href="/gibts-nicht.html">kaputt</a></p>`, meta_title: 'Vase | Holm', meta_description: 'y'.repeat(130), image: '/v/a/vase.jpg', small_image: '/v/a/vase.jpg', thumbnail: '/v/a/vase.jpg' },
      { categories: [{ id: 3, position: 1 }], images: [{ id: 1, file: '/v/a/vase.jpg', vals: { 0: { label: 'Vase', position: 1, disabled: false } } }] }),
    prod(2, 'BECHER', { name: 'Becher', price: 18, description: '<p>Becher</p>' }, { categories: [{ id: 4, position: 1 }], stock: { qty: 0, is_in_stock: true, manage_stock: true } }),
    prod(3, 'KERZE', { name: 'Kerze', price: 0, special_price: 5, description: '<p>Kerze</p>' }),
    prod(4, 'SCHALE', { name: 'Schale', price: 30, special_price: 35, description: '<p>Schale</p>' }),
    prod(5, 'AUS', { name: 'Ausgelaufen', price: 10, status: 2 }),
  ],
  cmsPages: [
    { id: 1, identifier: 'no-route', title: '404', content: '<p>404</p>', is_active: true, store_ids: [0], root_template: 'two_columns_right', content_heading: null, meta_keywords: null, meta_description: null, sort_order: 0 },
    { id: 5, identifier: 'ueber-uns', title: 'Über uns', content: '<p>Wir sind <a href="/alt.html">alt</a></p>{{block id="usp"}}', is_active: true, store_ids: [0], root_template: 'one_column', content_heading: 'Über uns', meta_keywords: null, meta_description: null, sort_order: 0 },
  ],
  cmsBlocks: [{ id: 1, identifier: 'usp', title: 'USP', content: '<ul><li>Versand</li></ul>', is_active: true, store_ids: [0] }],
});
process.env.SHOP_PLATFORM = 'openmage';
process.env.OPENMAGE_URL = fake.base;
process.env.OPENMAGE_TOKEN = fake.token;

const { renderContent, appendHtml, OPENMAGE_CAPABILITIES } = await import('./pages');
const { directiveGuard } = await import('./cms');
const { classifyHref } = await import('./links');
const { planOmImport, shopPrice } = await import('./importer');
const { openmage, openmageReaderFor } = await import('./index');
const { getSession, decideChange, undoChangeSet } = await import('../../sessions');
const { buildTools } = await import('../../tools');
const { stageImage } = await import('../../media');
const { saveFile } = await import('../../files');
const { auditSpec } = await import('../../audit');
const { listChecks } = await import('../../checks');
const { runChecks } = await import('../../shopcheck-run');
const { buildBasePrompt } = await import('../../prompt');
const { readRecords } = await import('../../features/import-plan');
const { parseTable } = await import('../../features/import-parse');

test.after(() => fake.close());

// ================= reine Logik =================
test('Rendern: statisches HTML mit Produktboxen, Direktiven entschärft, Block anhängen, Direktiven-Schutz, Links einordnen', () => {
  const spec = { name: 'S', type: 'landingpage' as const, sections: [{ blocks: [{ type: 'text-hero', html: '<h1>Herbst {{config path="x"}}</h1>' }, { type: 'product-slider', title: 'Favoriten', productIds: ['1'] }] }] };
  const html = renderContent(spec, { imageUrl: () => null, products: { 1: { id: '1', name: 'Vase', price: '49,00 €', url: 'https://shop.test/vase.html' } }, scope: 'lotse-t' });
  assert.match(html, /^<div class="lotse-t"><style>/); assert.match(html, /Vase/); assert.match(html, /49,00 €/); assert.match(html, /\{ \{config/); assert.doesNotMatch(html, /\{\{/);
  assert.equal(appendHtml('<p>Alt</p>', '<div>Neu</div>'), '<p>Alt</p>\n<div>Neu</div>'); assert.equal(appendHtml(null, '<b>x</b>'), '<b>x</b>');
  const g = directiveGuard('<p>{{block id="usp"}}</p>');
  assert.equal(g('<p>{{block id="usp"}} {{widget type="x"}}</p>'), '<p>{{block id="usp"}} { {widget type="x"}}</p>');
  const bases = ['https://shop.test'];
  assert.deepEqual(classifyHref('https://shop.test/index.php/vase.html?x', bases), { type: 'internal', path: 'vase.html' });
  assert.deepEqual(classifyHref('/kueche.html#a', bases), { type: 'internal', path: 'kueche.html' });
  assert.equal(classifyHref('https://fremd.test/x', bases).type, 'external'); assert.equal(classifyHref('javascript:alert(1)', bases).type, 'invalid'); assert.equal(classifyHref('{{store url="x"}}', bases).type, 'other');
  assert.deepEqual([...OPENMAGE_CAPABILITIES.publishTargets].sort(), ['category', 'landingpage', 'product']);
  assert.equal(shopPrice({ gross: 49 }, 'gross'), 49); assert.equal(shopPrice({ gross: 49 }, 'net'), 41.1765); assert.equal(shopPrice({}, 'net', 19, 'list', 119), 100);
  // Qualitäts-Check: Kategorie-Inhalt ohne H1 ist auf HTML-Plattformen richtig
  const a = auditSpec({ name: 'K', type: 'product_list', seo: { keyword: 'vasen' }, sections: [{ blocks: [{ type: 'text', html: `<h2>Vasen</h2><p>${words(120)}</p>` }] }] }, null, { format: 'html' });
  assert.ok(a.checks.find(c => /Keine eigene H1/.test(c.label))?.ok);
});

// ================= Werkzeuge gegen den Fake =================
type Res = { isError?: boolean; content: { text: string }[] };
const s = getSession('chat-openmage-pages');
const allow = true;
s.emit = ev => { s.events.push(ev); if (ev.t === 'changeset') setTimeout(() => decideChange('chat-openmage-pages', ev.approvalId, allow), 1); };
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
  const u = await undoChangeSet('chat-openmage-pages', lastResult().csId);
  assert.ok(u?.ok, `${label}: Rückgängig ${JSON.stringify(u)}`);
  assert.deepEqual(JSON.parse(fake.snapshot()), JSON.parse(before), `${label}: exakt wiederhergestellt`);
}
const draft = (spec: Record<string, unknown>) => call('draft_page', spec);

test('Entwurf: Blöcke laut Fähigkeiten, product_detail erlaubt, Link-Prüfung im Qualitäts-Check, Fokus', async () => {
  const bad = await draft({ name: 'X', type: 'product_detail', sections: [{ blocks: [{ type: 'pdp-gallery-buybox' }] }] });
  assert.match(bad.error, /pdp-gallery-buybox gibt es in OpenMage nicht/);
  const ok = await draft({ name: 'Vase', type: 'product_detail', previewProductId: '1', sections: [{ blocks: [{ type: 'text', html: '<h2>Details</h2><p><a href="/gibts-nicht.html">kaputt</a></p>' }] }] });
  assert.match(ok, /Entwurf "Vase"/); assert.match(ok, /kaputtem, inaktivem oder unsichtbarem Ziel|Link/);
  const focus = [...s.events].reverse().find(e => e.t === 'focus') as Extract<ChatEvent, { t: 'focus' }>;
  assert.equal(focus?.id, '1');
});

test('Landingpage veröffentlichen: CMS-Seite als HTML, Theme-Überschrift leer bei eigener H1, Produktboxen; Rückgängig löscht sie', async () => {
  const svg = stageImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'), 'image/svg+xml', { name: 'muster', alt: 'Muster' });
  await draft({ name: 'Herbst', type: 'landingpage', seo: { keyword: 'herbst', metaTitle: 'Herbst bei Holm | Haus Holm', metaDescription: 'z'.repeat(130) }, sections: [{ blocks: [{ type: 'text-hero', html: '<h1>Herbst</h1>' }, { type: 'image-two-column', image: { mediaId: 'om-1-1', alt: 'Vase' }, image2: { mediaId: svg.mediaId, alt: 'Muster' } }, { type: 'product-slider', title: 'Favoriten', productIds: ['1', 'BECHER', '5'] }] }] });
  const photo = stageImage(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64'), 'image/png', { name: 'foto', alt: 'Foto' });
  const s2 = { ...(s.draft!) }; s.draft = { ...s2, sections: [{ blocks: [{ type: 'image-cover', image: { mediaId: photo.mediaId, alt: 'x' } }] }] };
  assert.match((await call('publish_page', { target: 'landingpage', url: 'herbst' })).error, /keine Schnittstelle, um Bilder.*foto/);
  s.draft = s2;
  assert.match((await call('publish_page', { target: 'landingpage', url: 'ueber-uns' })).error, /schon vergeben/);
  assert.match((await call('publish_page', { target: 'landingpage', url: 'vase.html' })).error, /gehört schon zu einem Produkt/);
  assert.match((await call('publish_page', { target: 'category' })).error, /Entwurfstyp landingpage passt nicht/);
  await roundtrip('Landingpage', () => call('publish_page', { target: 'landingpage', url: 'Ratgeber/Herbst' }), () => {
    const pg = fake.cmsPages.find(p => p.identifier === 'ratgeber/herbst')!;
    assert.ok(pg, 'angelegt'); assert.deepEqual(pg.store_ids, [1], 'Store-View aus den Einstellungen');
    assert.equal(pg.title, 'Herbst bei Holm', 'Meta-Title = Seitentitel, ohne das Theme-Suffix „ | Haus Holm“ (OpenMage hängt es selbst an)'); assert.equal(pg.content_heading, '', 'eigene H1 → Theme-Überschrift leer'); assert.equal(pg.is_active, true); assert.equal(pg.root_template, 'one_column');
    const html = String(pg.content);
    assert.match(html, /\/media\/catalog\/product\/v\/a\/vase\.jpg/); assert.match(html, /data:image\/svg\+xml;base64,/); assert.match(html, /49,00 €/); assert.match(html, /Becher/);
    const cs = lastCs().cs;
    assert.ok(cs.items[0].warn.some(w => /Ausgelaufen.*deaktiviert/.test(w)), 'deaktiviertes Produkt gewarnt');
    assert.ok(cs.items[0].warn.some(w => /statisch/.test(w)), 'Hinweis auf statische Produktboxen');
    assert.equal(lastResult().published?.storefront, `${fake.base}/ratgeber/herbst`);
  });
  // ohne H1: Theme-Überschrift = Seitentitel, alle Store-Views
  await draft({ name: 'Service', type: 'landingpage', sections: [{ blocks: [{ type: 'text', html: '<h2>Service</h2><p>x</p>' }] }] });
  await roundtrip('Landingpage ohne H1', () => call('publish_page', { target: 'landingpage', url: 'service', allStoreViews: true, title: 'Unser Service' }), () => {
    const pg = fake.cmsPages.find(p => p.identifier === 'service')!;
    assert.equal(pg.content_heading, 'Unser Service'); assert.deepEqual(pg.store_ids, [0]);
  });
});

test('Kategorie-Inhalt veröffentlichen: CMS-Block + Anzeigemodus + Metas, Rückgängig stellt Kategorie exakt her und löscht den Block', async () => {
  await draft({ name: 'Wohnen Intro', type: 'product_list', previewCategoryId: '3', seo: { keyword: 'wohnen', metaTitle: 'Wohnaccessoires | Holm', metaDescription: 'm'.repeat(130) }, sections: [{ blocks: [{ type: 'text', html: '<h1>Wohnen</h1><p>Ruhige Dinge.</p>' }] }] });
  await roundtrip('Kategorie', () => call('publish_page', { target: 'category', categoryId: '3' }), () => {
    const cat = fake.categories.find(c => c.id === 3)!.vals[0], blk = fake.cmsBlocks.find(b => String(b.identifier).startsWith('lotse-kategorie-3-'))!;
    assert.ok(blk, 'Block angelegt'); assert.deepEqual(blk.store_ids, [0]);
    assert.equal(cat.display_mode, 'PRODUCTS_AND_PAGE'); assert.equal(cat.landing_page, blk.id); assert.equal(cat.meta_title, 'Wohnaccessoires | Holm');
    assert.doesNotMatch(String(blk.content), /<h1/, 'H1 → H2');
    assert.ok(lastCs().cs.items[0].warn.some(w => /H1-Überschrift/.test(w)));
  });
  assert.match((await call('publish_page', { target: 'category', categoryId: '2' })).error, /Wurzelkategorie/);
});

test('Produktinhalt: ein Produkt ersetzt die Beschreibung, mehrere bekommen den Inhalt darunter (kein {{block}}); Rückgängig exakt', async () => {
  await draft({ name: 'Vase Details', type: 'product_detail', previewProductId: '1', sections: [{ blocks: [{ type: 'text', html: '<h2>Pflege</h2><p>Feucht abwischen.</p>' }] }] });
  await roundtrip('Beschreibung', () => call('publish_page', { target: 'product', productIds: ['1'] }), () => {
    const d = String(fake.products.find(p => p.sku === 'VASE')!.vals[0].description);
    assert.match(d, /^<div class="lotse-/); assert.match(d, /Feucht abwischen/);
  });
  const blocksBefore = fake.cmsBlocks.length;
  await roundtrip('Anhängen', () => call('publish_page', { target: 'product', productIds: ['1', 'BECHER'] }), () => {
    for (const sku of ['VASE', 'BECHER']) { const d = String(fake.products.find(p => p.sku === sku)!.vals[0].description); assert.match(d, /Feucht abwischen/); assert.doesNotMatch(d, /\{\{block/); }
    assert.match(String(fake.products.find(p => p.sku === 'BECHER')!.vals[0].description), /^<p>Becher<\/p>\n<div class="lotse-/, 'bisheriger Text bleibt erhalten, Inhalt darunter');
    assert.equal(fake.cmsBlocks.length, blocksBefore, 'kein CMS-Block für Produkte');
  });
});

test('Fehler beim Veröffentlichen nimmt Geschriebenes sofort zurück (atomar)', async () => {
  await draft({ name: 'Kat', type: 'product_list', previewCategoryId: '4', sections: [{ blocks: [{ type: 'text', html: '<p>x</p>' }] }] });
  const before = fake.snapshot(), k = fake.categories.find(c => c.id === 4)!;
  const orig = s.emit;
  s.emit = ev => { if (ev.t === 'changeset') fake.categories = fake.categories.filter(c => c.id !== 4); orig(ev); };
  const r = await call('publish_page', { target: 'category', categoryId: '4' });
  s.emit = orig; fake.categories.push(k); fake.categories.sort((a, b) => a.id - b.id);
  assert.equal(r.status, 'failed', JSON.stringify(r));
  assert.equal(fake.snapshot(), before, 'Block wieder gelöscht');
});

test('CMS-Seiten lesen und ändern: Direktiven bleiben, Systemseiten gesperrt, Rückgängig exakt', async () => {
  const list = await call('list_cms_pages', {});
  assert.equal(list.total, 2); assert.equal(list.items[1].identifier, 'ueber-uns');
  const blocks = await call('list_cms_pages', { entity: 'block' });
  assert.equal(blocks.items[0].identifier, 'usp');
  const pg = await call('get_cms_page', { id: 'ueber-uns' });
  assert.match(pg.html, /<a href="\/alt.html">alt<\/a>/); assert.deepEqual(pg.directives, ['{{block id="usp"}}']);
  await roundtrip('CMS-Seite', () => call('propose_cms_page_changes', { title: 'Link', reason: 'kaputt', changes: [{ id: '5', fields: { content: '<p>Wir sind <a href="/kueche.html">Küche</a></p>{{block id="usp"}} {{widget type="neu"}}', metaDescription: 'Neu', title: 'Über uns neu', active: true } }] }), () => {
    const p = fake.cmsPages.find(x => x.id === 5)!;
    assert.match(String(p.content), /\{\{block id="usp"\}\} \{ \{widget/, 'alte Direktive bleibt, neue entschärft'); assert.equal(p.meta_description, 'Neu'); assert.equal(p.identifier, 'ueber-uns');
  });
  const sys = await call('propose_cms_page_changes', { title: 'x', reason: 'x', changes: [{ id: 'no-route', fields: { title: 'Weg' } }] });
  assert.match(sys.error, /Systemseite/);
});

test('read_page: nur eigener Shop, Ziel wird erkannt', async () => {
  assert.match((await call('read_page', { url: 'https://fremd.test/x' })).error, /nur Seiten des eigenen Shops/);
  const r = await call('read_page', { url: `${fake.base}/vase.html` });
  assert.equal(r.target?.type, 'PRODUCT'); assert.equal(r.hint, 'Daten: get_product');
});

test('Shop-Check: OpenMage-Prüfungen mit Befunden und gemeinsamen Werkzeugnamen im Auftrag', async () => {
  await openmage.loadChecks();
  const checks = listChecks('openmage').filter(c => c.id.startsWith('openmage.'));
  assert.ok(checks.length >= 12);
  const ro = openmageReaderFor('shop-check');
  const run = await runChecks(ro as never, checks, { perRun: false, ctx: r => ({ platform: 'openmage', reader: r, lookup: openmage.lookup(r) }) });
  assert.deepEqual(run.errors, []);
  const by = (id: string) => run.findings.find(f => f.id === id);
  assert.equal(by('seo.product-meta-description-missing')?.count, 3); // BECHER, KERZE, SCHALE (AUS ist deaktiviert)
  assert.match(by('seo.product-meta-description-missing')!.fixPrompt, /seo_audit.*propose_product_changes/);
  assert.match(String(by('daten.stock-zero-orderable')?.hint), /Lagerposten/);
  assert.equal(by('preise.price-zero')?.sample?.[0]?.id, '3');
  assert.equal(by('preise.special-not-below')?.count, 2);
  assert.equal(by('daten.stock-zero-orderable')?.sample?.[0]?.label, 'Becher (BECHER)');
  assert.match(by('links.product-description')?.sample?.[0]?.label ?? '', /Vase \(VASE\): Ziel nicht gefunden/);
  assert.match(by('links.cms-broken')?.sample?.[0]?.label ?? '', /Über uns.*Kategorie ist inaktiv/);
  assert.equal(by('seo.category-meta-description-missing')?.count, 1);
  assert.match(by('bilder.product-without-image')!.fixPrompt, /find_image_gaps/);
  assert.ok(by('sprachen.missing-translation.en'), 'Store-View en (en_US) ohne Übersetzung');
  for (const f of run.findings) { assert.doesNotMatch(f.fixPrompt, /find_products_by_data|get_product_details|suggest_internal_links|Einkaufswelt|Shopware/, f.id); assert.doesNotMatch(String(f.hint ?? ''), /Magento/, f.id); }
});

test('Import: Plan (neu als Entwurf, nur geänderte Felder, Preise nur mit Option, Varianten übersprungen) und Rückgängig exakt', async () => {
  const csv = 'SKU;Name;Preis;UVP;Bestand;Beschreibung;Kategorie;Hauptartikel\nVASE;Vase neu;49,00;;10;;Wohnaccessoires;\nNEU-1;Neue Schale;29,90;39,90;5;Schöne Schale;Küche;\nNEU-2;Ohne Preis;;;;;;\nVAR-1;Variante;10;;;;;VASE\n';
  const t = await parseTable(Buffer.from(csv), 'liste.csv');
  const mapping = { productNumber: 'SKU', name: 'Name', priceGross: 'Preis', listPrice: 'UVP', stock: 'Bestand', description: 'Beschreibung', category: 'Kategorie', parentNumber: 'Hauptartikel' };
  const recs = readRecords(t, mapping);
  const cat = { products: [{ id: 1, sku: 'VASE', type_id: 'simple', name: 'Vase', price: 49, qty: 10, is_in_stock: true, category_ids: [3], images: [{ id: 1 }], attributes: {} }], categories: [{ id: '3', path: ['Wohnaccessoires'] }, { id: '4', path: ['Küche'] }], attributes: [], taxClasses: [{ label: 'Taxable Goods', value: 2 }], attributeSetId: 4, websiteIds: [1], basis: 'gross' as const };
  const plan = planOmImport(recs, mapping, cat as never, {}, { title: 'T', reason: '', fileName: 'liste.csv', nextOffset: null });
  assert.equal(plan.stats.create, 1); assert.equal(plan.stats.update, 1);
  const create = plan.payload.plans.find(p => p.kind === 'create')!;
  assert.equal(create.kind === 'create' && create.product.price, 39.9, 'UVP = regulärer Preis'); assert.equal(create.kind === 'create' && create.product.extra?.special_price, 29.9); assert.equal(create.kind === 'create' && create.product.active, false);
  const upd = plan.payload.plans.find(p => p.kind === 'update')!;
  assert.deepEqual(upd.kind === 'update' && upd.scoped, { name: 'Vase neu' }, 'nur Name, Preis/Bestand ohne Option nicht');
  assert.ok(plan.cs.skipped.some(x => /Variante/.test(x.reason)) && plan.cs.skipped.some(x => /Preis fehlt/.test(x.reason)));
  const sale = { ...cat, products: [{ ...cat.products[0], price: 100, special_price: 80, qty: 5 }] }, pm = { productNumber: 'SKU', priceGross: 'Preis', stock: 'Bestand' };
  const one = async (row: string) => planOmImport(readRecords(await parseTable(Buffer.from(`SKU;Preis;Bestand\n${row}\n`), 'x.csv'), pm), pm, sale as never, { updatePrices: true, updateStock: true }, { title: 'T', reason: '', fileName: 'x.csv', nextOffset: null });
  const p90 = await one('VASE;90;5'), u90 = p90.payload.plans[0];
  assert.deepEqual(u90.kind === 'update' && u90.global, { special_price: 90, special_from_date: null });
  assert.equal(p90.cs.sample![0].after, 'Preis: 90,00 € statt 100,00 €');
  await assert.rejects(one('VASE;80;5'), /1 unverändert/);
  // Ende-zu-Ende über das Werkzeug gegen den Fake
  const f = saveFile(Buffer.from(csv), 'liste.csv');
  const prev = await call('preview_import', { fileId: f.fileId, mapping, options: { updatePrices: true, updateStock: true } });
  assert.equal(prev.stats.create, 1); assert.equal(prev.stats.update, 1);
  await roundtrip('Import', () => call('propose_import', { fileId: f.fileId, title: 'Import', reason: 'Lieferant', mapping, options: { updatePrices: true, updateStock: true } }), () => {
    const n = fake.products.find(p => p.sku === 'NEU-1')!;
    assert.ok(n, 'angelegt'); assert.equal(n.vals[0].status, 2, 'Entwurf'); assert.equal(n.vals[0].price, 39.9); assert.equal(n.vals[0].special_price, 29.9); assert.equal(n.stock.qty, 5);
    assert.deepEqual(n.categories, [{ id: 4, position: 0 }]);
    assert.equal(fake.products.find(p => p.sku === 'VASE')!.vals[0].name, 'Vase neu');
  });
});

test('Prompt: OpenMage-Seiten, Import und CMS ohne fremde Begriffe', () => {
  const p = buildBasePrompt('openmage');
  assert.doesNotMatch(p, /\{\{\w+\}\}|Shopware|Einkaufswelt|noch nicht verfügbar|Produktseiten-Layouts \(product_detail\) gibt es|mg-/);
  assert.match(p, /## So funktionieren Seiten in OpenMage/); assert.match(p, /## Import aus Lieferantendaten/); assert.match(p, /propose_cms_page_changes/); assert.match(p, /Lotse_Connector/);
  assert.match(p, /seo_audit, find_image_gaps, list_products, get_cms_page/);
  for (const line of p.split('\n').filter(l => /OpenMage/.test(l))) assert.doesNotMatch(line, /—/);
});

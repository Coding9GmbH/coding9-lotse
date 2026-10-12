// Magento: Seiten (Page Builder, Veröffentlichen mit exaktem Rückgängig), CMS-Seiten ändern, Link-Prüfung, Shop-Check, Import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatEvent } from '@/lib/protocol';
import { startFakeMagento, type FakeProduct } from './fake';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-magento-pages-'));
const prod = (id: number, sku: string, v: Record<string, unknown>, extra: Partial<FakeProduct> = {}): FakeProduct => ({ id, sku, type_id: 'simple', attribute_set_id: 4, website_ids: [1], media: [], vals: { 0: { status: 1, visibility: 4, url_key: sku.toLowerCase(), ...v } }, ...extra });
const words = (n: number) => Array.from({ length: n }, (_, i) => `Wort${i}`).join(' ');
const fake = await startFakeMagento({
  categories: [
    { id: 2, parent_id: 1, level: 1, path: '1/2', vals: { 0: { name: 'Default Category', is_active: true } }, products: [] },
    { id: 3, parent_id: 2, level: 2, path: '1/2/3', vals: { 0: { name: 'Wohnaccessoires', is_active: true, description: '<p>Wohnen</p>', url_key: 'wohnaccessoires', url_path: 'wohnaccessoires', meta_description: 'x'.repeat(130) } }, products: [{ sku: 'VASE', position: 0 }] },
    { id: 4, parent_id: 2, level: 2, path: '1/2/4', vals: { 0: { name: 'Küche', is_active: true, url_key: 'kueche', url_path: 'kueche' } }, products: [{ sku: 'BECHER', position: 1 }] },
    { id: 5, parent_id: 2, level: 2, path: '1/2/5', vals: { 0: { name: 'Alt', is_active: false, url_key: 'alt', url_path: 'alt' } }, products: [] },
  ],
  products: [
    prod(1, 'VASE', { name: 'Vase', price: 49, description: `<p>Vase aus Steinzeug. ${words(60)} <a href="/becher.html">Becher</a> <a href="/gibts-nicht.html">kaputt</a></p>`, meta_title: 'Vase | Holm', meta_description: 'y'.repeat(130), image: '/v/a/vase.jpg', small_image: '/v/a/vase.jpg', thumbnail: '/v/a/vase.jpg' },
      { media: [{ id: 1, file: '/v/a/vase.jpg', media_type: 'image', vals: { 0: { label: 'Vase', position: 1, disabled: false } } }] }),
    prod(2, 'BECHER', { name: 'Becher', price: 18, description: '<p>Becher</p>' }),
    prod(3, 'KERZE', { name: 'Kerze', price: 0, special_price: 5, description: '<p>Kerze</p>' }),
    prod(4, 'SCHALE', { name: 'Schale', price: 30, special_price: 35, status: 1, description: '<p>Schale</p>' }),
    prod(5, 'AUS', { name: 'Ausgelaufen', price: 10, status: 2 }),
  ],
  sourceItems: [{ sku: 'VASE', source_code: 'default', quantity: 10, status: 1 }, { sku: 'BECHER', source_code: 'default', quantity: 0, status: 1 }],
  cmsPages: [
    { id: 1, identifier: 'no-route', title: '404', content: '<p>404</p>', active: true, store_id: [0] },
    { id: 5, identifier: 'ueber-uns', title: 'Über uns', content: '<div data-content-type="row" data-appearance="contained" data-element="main"><div data-element="inner"><div data-content-type="text" data-appearance="default" data-element="main"><p>Wir sind <a href="/alt.html">alt</a></p></div></div></div>', active: true, meta_title: 'Über uns', store_id: [0] },
  ],
  cmsBlocks: [{ id: 1, identifier: 'usp', title: 'USP', content: '<ul><li>Versand</li></ul>', active: true, store_id: [0] }],
});
process.env.SHOP_PLATFORM = 'magento';
process.env.MAGENTO_URL = fake.base;
process.env.MAGENTO_ACCESS_TOKEN = fake.token;
process.env.MAGENTO_PRICE_BASIS = 'gross';

const pb = await import('./pagebuilder');
const { renderParts, demoteH1, cmsIdentifier, cmsBodyClass, hideThemeTitle, MAGENTO_CAPABILITIES } = await import('./pages');
const { cmsContent } = await import('./cms');
const { classifyHref } = await import('./links');
const { productHits, untranslated, categoryHits } = await import('./checks-rules');
const { planMagentoImport, shopPrice } = await import('./importer');
const { magento, magentoReaderFor } = await import('./index');
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
test('Page Builder: Zeile mit html-Element (kodiert, ohne Direktiven), Produkt-Widget mit SKU-Bedingung, Block-Widget, Anhängen, Lesbarmachen', () => {
  const c = pb.toPageBuilder([{ kind: 'html', html: '<div class="x"><style>.x{color:red}</style><p>A & B "C" {{var}}</p></div>' }, { kind: 'products', skus: ['VASE', 'BE"CHER'] }]);
  assert.match(c, /^<div data-content-type="row" data-appearance="contained" data-element="main">/);
  assert.match(c, /<div data-content-type="html" data-appearance="default" data-element="main">&lt;div class=&quot;x&quot;&gt;&lt;style&gt;/);
  assert.match(c, /A &amp; B &quot;C&quot; \{ \{var\}\}/, 'Direktiven entschärft');
  assert.doesNotMatch(c.replace(/\{\{widget[^}]*\}\}/g, ''), /\{\{/);
  assert.match(c, /<div data-content-type="products" data-appearance="grid" data-element="main">\{\{widget type="Magento\\CatalogWidget\\Block\\Product\\ProductsList"/);
  assert.match(c, /condition_option="sku" condition_option_value="VASE, BECHER"/);
  assert.match(c, /conditions_encoded="\^\[`1`:\^\[`aggregator`:`all`/);
  assert.match(c, /`attribute`:`sku`,`value`:`VASE, BECHER`/);
  assert.match(c, /products_count="2"/); assert.match(c, /sort_order="position_by_sku"/);
  assert.equal(pb.readableHtml(c).includes('<style>.x{color:red}</style>'), true, 'html-Element wieder lesbar');
  assert.match(pb.blockWidget(7), /^\{\{widget type="Magento\\Cms\\Block\\Widget\\Block" template="widget\/static_block\/default.phtml" block_id="7" type_name="CMS Static Block"\}\}$/);
  // Anhängen: klassisches HTML wird html-Element, Page Builder bekommt eine neue Zeile
  const a = pb.appendPart('<p>Alt</p>', { kind: 'block', blockId: 9 });
  assert.ok(pb.isPageBuilder(a) && a.includes('&lt;p&gt;Alt&lt;/p&gt;') && a.includes('block_id="9"'));
  const b = pb.appendPart(c, { kind: 'block', blockId: 9 });
  assert.ok(b.startsWith(c) && b.split('data-content-type="row"').length === 3);
  assert.equal(pb.appendPart(null, { kind: 'block', blockId: 9 }).includes('block_id="9"'), true);
});

test('CMS-Inhalt: lesbares Page-Builder-HTML wird wieder kodiert, vorhandene Direktiven bleiben, neue werden entschärft', () => {
  const cur = pb.toPageBuilder([{ kind: 'html', html: '<div><p>A &amp; B</p><div>innen</div></div>' }]).replace('innen', 'innen {{store url=&quot;kontakt&quot;}}');
  const read = pb.readableHtml(cur);
  assert.match(read, /<div><p>A &amp; B<\/p><div>innen \{\{store url="kontakt"\}\}<\/div><\/div>/);
  assert.equal(pb.storableHtml(cur), cur, 'unveränderter Inhalt bleibt wörtlich');
  // Modell schickt den lesbaren Inhalt geändert zurück
  const edited = read.replace('innen', 'innen neu').replace('</div></div></div></div>', '{{config path="x"}}</div></div></div></div>');
  const next = cmsContent(cur, edited);
  assert.doesNotMatch(next, /data-element="main"><div>/, 'html-Element wieder kodiert (kein rohes HTML)');
  assert.match(next, /&lt;div&gt;innen neu \{\{store url=&quot;kontakt&quot;\}\}\{ \{config path=&quot;x&quot;\}\}&lt;\/div&gt;&lt;\/div&gt;<\/div>/, 'verschachtelte divs vollständig kodiert, bekannte Direktive erhalten, neue entschärft');
  assert.equal(pb.readableHtml(next), edited.replace('{{config', '{ {config'));
  // freies HTML in eine Page-Builder-Seite: vorhandene Direktive bleibt
  const wrapped = cmsContent(cur, '<p>{{store url="kontakt"}} {{widget type="x"}}</p>');
  assert.match(wrapped, /\{\{store url=&quot;kontakt&quot;\}\}/); assert.match(wrapped, /\{ \{widget type=&quot;x&quot;\}\}/);
  // klassische Seite bleibt klassisch
  assert.equal(cmsContent('<p>{{block id="1"}}</p>', '<p>{{block id="1"}} {{block id="2"}}</p>'), '<p>{{block id="1"}} { {block id="2"}}</p>');
  assert.equal(hideThemeTitle('ratgeber/vasen'), '.cms-ratgeber-vasen .page-title-wrapper,.cms-ratgeber-vasen h1.page-title{display:none}');
});

test('Rendern: Produkt-Slider → Widget, Titel als H2, Stile nur im ersten Teil, H1 auf Kategorie/Produkt → H2, Identifier', () => {
  const spec = { name: 'S', type: 'landingpage' as const, sections: [{ blocks: [{ type: 'text-hero', html: '<h1>Herbst</h1>' }, { type: 'product-slider', title: 'Favoriten', productIds: ['1', '2', 'X'] }, { type: 'text', html: '<p>Ende</p>' }] }] };
  const parts = renderParts(spec, { imageUrl: () => null, skus: { 1: 'VASE', 2: 'BECHER' }, scope: 'lotse-t', extraCss: '.cms-x .page-title-wrapper{display:none}' });
  assert.deepEqual(parts.map(p => p.kind), ['html', 'products', 'html']);
  assert.deepEqual(parts[1], { kind: 'products', skus: ['VASE', 'BECHER'] });
  const h0 = (parts[0] as { html: string }).html, h2 = (parts[2] as { html: string }).html;
  assert.match(h0, /^<style>\.cms-x \.page-title-wrapper\{display:none\}<\/style><div class="lotse-t"><style>/); assert.match(h0, /<h2>Favoriten<\/h2>/);
  assert.match(h2, /^<div class="lotse-t"><section/, 'Folgeteile ohne doppeltes CSS');
  const d = demoteH1({ name: 'K', type: 'product_list', sections: [{ blocks: [{ type: 'text', html: '<h1 class="a">Titel</h1><p>x</p>' }, { type: 'pattern', pattern: 'hero', data: { title: 'Hero', ctaText: 'Los', ctaHref: '/x' } }] }] });
  assert.equal(d.n, 2); assert.doesNotMatch(JSON.stringify(d.spec), /<h1/);
  assert.equal(cmsIdentifier(' /Ratgeber/Vasen & Schalen.html?x=1'), 'ratgeber/vasen-schalen.html');
  assert.equal(cmsIdentifier('https://shop.test/herbst-2026/'), 'herbst-2026');
  assert.throws(() => cmsIdentifier('/'), /url fehlt/);
  assert.equal(cmsBodyClass('ratgeber/vasen.html'), 'cms-ratgeber-vasen-html');
  assert.deepEqual([...MAGENTO_CAPABILITIES.publishTargets].sort(), ['category', 'landingpage', 'product']);
});

test('Links einordnen, Shop-Check-Regeln, Preisbasis im Import, Qualitäts-Check für HTML-Plattformen', () => {
  const bases = ['https://shop.test'];
  assert.deepEqual(classifyHref('https://shop.test/vase.html?x', bases), { type: 'internal', path: 'vase.html' });
  assert.deepEqual(classifyHref('/kueche.html#a', bases), { type: 'internal', path: 'kueche.html' });
  assert.equal(classifyHref('https://fremd.test/x', bases).type, 'external');
  assert.equal(classifyHref('javascript:alert(1)', bases).type, 'invalid');
  assert.equal(classifyHref('{{store url="x"}}', bases).type, 'other');
  const rows = [
    { id: 1, sku: 'A', name: 'A', type_id: 'simple', status: 1, price: 0, custom_attributes: [{ attribute_code: 'meta_title', value: 'Gleich' }], media_gallery_entries: [] },
    { id: 2, sku: 'B', name: 'B', type_id: 'simple', status: 1, price: 10, custom_attributes: [{ attribute_code: 'meta_title', value: 'Gleich' }, { attribute_code: 'special_price', value: '12' }, { attribute_code: 'meta_description', value: 'x' }, { attribute_code: 'description', value: words(60) }], media_gallery_entries: [{ id: 1, label: '' }] },
  ];
  const h = productHits(rows, new Map([['A', { qty: 0, inStock: true }], ['B', { qty: 3, inStock: true }]]));
  const ch = categoryHits([{ id: 7, name: 'Mit Block', custom_attributes: [{ attribute_code: 'display_mode', value: 'PRODUCTS_AND_PAGE' }, { attribute_code: 'landing_page', value: '3' }] }, { id: 8, name: 'Nur Produkte', custom_attributes: [{ attribute_code: 'display_mode', value: 'PRODUCTS' }, { attribute_code: 'landing_page', value: '3' }] }]);
  assert.deepEqual(ch.desc.map(x => x.id), ['8'], 'CMS-Block zählt als Beschreibung');
  assert.deepEqual(h.metaDescMissing.map(x => x.id), ['1']); assert.equal(h.metaTitleDup.count, 2); assert.deepEqual(h.thin.map(x => x.id), ['1']);
  assert.deepEqual(h.noImage.map(x => x.id), ['1']); assert.deepEqual(h.altMissing.map(x => x.id), ['2']); assert.deepEqual(h.priceZero.map(x => x.id), ['1']);
  assert.deepEqual(h.specialNotBelow.map(x => x.id), ['2']); assert.deepEqual(h.stockZero.map(x => x.id), ['1']);
  assert.deepEqual(untranslated([{ id: 1, sku: 'A', name: 'Vase' }, { id: 2, sku: 'B', name: 'Becher' }], [{ id: 1, sku: 'A', name: 'Vase' }, { id: 2, sku: 'B', name: 'Mug' }]).map(x => x.id), ['1']);
  assert.deepEqual(categoryHits([{ id: 3, name: 'K', custom_attributes: [{ attribute_code: 'description', value: '<p>x</p>' }] }]).meta.map(x => x.id), ['3']);
  assert.equal(shopPrice({ gross: 49 }, 'gross'), 49); assert.equal(shopPrice({ gross: 49 }, 'net'), 41.1765); assert.equal(shopPrice({ net: 10, taxRate: 7 }, 'gross'), 10.7);
  assert.equal(shopPrice({}, 'net', 19, 'list', 119), 100);
  // Qualitäts-Check: Kategorie-Inhalt ohne H1 und ohne product-listing ist auf HTML-Plattformen richtig
  const list = { name: 'K', type: 'product_list' as const, seo: { keyword: 'vasen' }, sections: [{ blocks: [{ type: 'text', html: `<h2>Vasen</h2><p>${words(120)}</p>` }] }] };
  const a = auditSpec(list, null, { format: 'html' });
  assert.ok(a.checks.find(c => /Keine eigene H1/.test(c.label))?.ok, 'keine H1 = richtig');
  assert.ok(!a.checks.some(c => /Listing nach Hero|product-listing/.test(c.label)), 'kein product-listing verlangt');
  assert.ok(a.checks.find(c => /Produkte früh erreichbar/.test(c.label))?.ok);
  assert.ok(!auditSpec(list).checks.find(c => /Genau eine H1|EINE H1/.test(c.label))?.ok, 'Shopware verlangt weiter eine H1');
  const pdp = auditSpec({ name: 'P', type: 'product_detail', sections: [{ blocks: [{ type: 'text', html: '<h1>X</h1>' }] }] }, null, { format: 'html' });
  assert.ok(!pdp.checks.some(c => /pdp-/.test(c.label)), 'keine pdp-Blöcke verlangt');
  assert.equal(pdp.checks.find(c => /H1/.test(c.label))?.ok, false, 'H1 im Produktinhalt ist falsch');
});

// ================= Werkzeuge gegen den Fake =================
type Res = { isError?: boolean; content: { text: string }[] };
const s = getSession('chat-magento-pages');
let allow = true;
s.emit = ev => { s.events.push(ev); if (ev.t === 'changeset') setTimeout(() => decideChange('chat-magento-pages', ev.approvalId, allow), 1); };
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
  const u = await undoChangeSet('chat-magento-pages', lastResult().csId);
  assert.ok(u?.ok, `${label}: Rückgängig ${JSON.stringify(u)}`);
  assert.deepEqual(JSON.parse(fake.snapshot()), JSON.parse(before), `${label}: exakt wiederhergestellt`);
}
const draft = (spec: Record<string, unknown>) => call('draft_page', spec);

test('Entwurf: Blöcke laut Fähigkeiten, product_detail erlaubt, Link-Prüfung im Qualitäts-Check', async () => {
  const bad = await draft({ name: 'X', type: 'product_detail', sections: [{ blocks: [{ type: 'pdp-gallery-buybox' }] }] });
  assert.match(bad.error, /pdp-gallery-buybox gibt es in Magento nicht/);
  const ok = await draft({ name: 'Vase', type: 'product_detail', previewProductId: '1', sections: [{ blocks: [{ type: 'text', html: '<h2>Details</h2><p><a href="/gibts-nicht.html">kaputt</a></p>' }] }] });
  assert.match(ok, /Entwurf "Vase"/); assert.match(ok, /kaputtem, inaktivem oder unsichtbarem Ziel|Link/);
  const focus = [...s.events].reverse().find(e => e.t === 'focus') as Extract<ChatEvent, { t: 'focus' }>;
  assert.equal(focus?.id, '1');
});

test('Landingpage veröffentlichen: CMS-Seite im Page-Builder-Format, Seitentitel ausgeblendet, Widget mit Live-Preisen; Rückgängig löscht sie', async () => {
  const svg = stageImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'), 'image/svg+xml', { name: 'muster', alt: 'Muster' });
  await draft({ name: 'Herbst', type: 'landingpage', seo: { keyword: 'herbst', metaTitle: 'Herbst bei Holm', metaDescription: 'z'.repeat(130) }, sections: [{ blocks: [{ type: 'text-hero', html: '<h1>Herbst</h1>' }, { type: 'image-two-column', image: { mediaId: 'mg-1-1', alt: 'Vase' }, image2: { mediaId: svg.mediaId, alt: 'Muster' } }, { type: 'product-slider', title: 'Favoriten', productIds: ['1', 'BECHER', '5'] }] }] });
  // Fotos aus dem Chat gehen in Magento-Seiten nicht
  const photo = stageImage(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64'), 'image/png', { name: 'foto', alt: 'Foto' });
  const s2 = { ...(s.draft!) }; s.draft = { ...s2, sections: [{ blocks: [{ type: 'image-cover', image: { mediaId: photo.mediaId, alt: 'x' } }] }] };
  assert.match((await call('publish_page', { target: 'landingpage', url: 'herbst' })).error, /keine Schnittstelle, um Bilder.*foto/);
  s.draft = s2;
  assert.match((await call('publish_page', { target: 'landingpage', url: 'ueber-uns' })).error, /schon vergeben/);
  assert.match((await call('publish_page', { target: 'landingpage', url: 'vase.html' })).error, /gehört schon zu einem Produkt/);
  assert.match((await call('publish_page', { target: 'category' })).error, /Entwurfstyp landingpage passt nicht/);
  await roundtrip('Landingpage', () => call('publish_page', { target: 'landingpage', url: 'Ratgeber/Herbst' }), () => {
    const pg = fake.cmsPages.find(p => p.identifier === 'ratgeber/herbst')!;
    assert.ok(pg, 'angelegt'); assert.deepEqual(pg.store_id, [1], 'Store-View aus den Einstellungen');
    assert.equal(pg.title, 'Herbst'); assert.equal(pg.meta_title, 'Herbst bei Holm'); assert.equal(pg.active, true);
    const html = pb.readableHtml(String(pg.content));
    assert.match(html, /\.cms-ratgeber-herbst \.page-title-wrapper,\.cms-ratgeber-herbst h1\.page-title\{display:none\}/, 'Luma und Hyvä');
    assert.match(html, /\/media\/catalog\/product\/v\/a\/vase\.jpg/); assert.match(html, /data:image\/svg\+xml;base64,/);
    assert.match(String(pg.content), /condition_option_value="VASE, BECHER, AUS"/);
    const cs = lastCs().cs;
    assert.ok(cs.items[0].warn.some(w => /Ausgelaufen.*deaktiviert/.test(w)), 'deaktiviertes Produkt gewarnt');
    const res = lastResult();
    assert.equal(res.published?.storefront, `${fake.base}/ratgeber/herbst`);
  });
});

test('Kategorie-Inhalt veröffentlichen: CMS-Block + Anzeigemodus + Metas, Rückgängig stellt Kategorie exakt her und löscht den Block', async () => {
  await draft({ name: 'Wohnen Intro', type: 'product_list', previewCategoryId: '3', seo: { keyword: 'wohnen', metaTitle: 'Wohnaccessoires | Holm', metaDescription: 'm'.repeat(130) }, sections: [{ blocks: [{ type: 'text', html: '<h1>Wohnen</h1><p>Ruhige Dinge.</p>' }] }] });
  await roundtrip('Kategorie', () => call('publish_page', { target: 'category', categoryId: '3' }), () => {
    const cat = fake.categories.find(c => c.id === 3)!.vals[0], blk = fake.cmsBlocks.find(b => String(b.identifier).startsWith('lotse-kategorie-3-'))!;
    assert.ok(blk, 'Block angelegt'); assert.deepEqual(blk.store_id, [0]);
    assert.equal(cat.display_mode, 'PRODUCTS_AND_PAGE'); assert.equal(cat.landing_page, String(blk.id)); assert.equal(cat.meta_title, 'Wohnaccessoires | Holm');
    assert.doesNotMatch(pb.readableHtml(String(blk.content)), /<h1/, 'H1 → H2');
    assert.ok(lastCs().cs.items[0].warn.some(w => /H1-Überschrift/.test(w)));
  });
  assert.match((await call('publish_page', { target: 'category', categoryId: '2' })).error, /Wurzelkategorie/);
});

test('Produktinhalt: ein Produkt ersetzt die Beschreibung, mehrere bekommen einen Block darunter; Rückgängig exakt', async () => {
  await draft({ name: 'Vase Details', type: 'product_detail', previewProductId: '1', sections: [{ blocks: [{ type: 'text', html: '<h2>Pflege</h2><p>Feucht abwischen.</p>' }] }] });
  await roundtrip('Beschreibung', () => call('publish_page', { target: 'product', productIds: ['1'] }), () => {
    const d = String(fake.products.find(p => p.sku === 'VASE')!.vals[0].description);
    assert.ok(pb.isPageBuilder(d)); assert.match(pb.readableHtml(d), /Feucht abwischen/);
  });
  await roundtrip('Block', () => call('publish_page', { target: 'product', productIds: ['1', 'BECHER'] }), () => {
    const blk = fake.cmsBlocks.find(b => String(b.identifier).startsWith('lotse-produkt-'))!;
    for (const sku of ['VASE', 'BECHER']) { const d = String(fake.products.find(p => p.sku === sku)!.vals[0].description); assert.match(d, new RegExp(`block_id="${blk.id}"`)); }
    assert.match(String(fake.products.find(p => p.sku === 'BECHER')!.vals[0].description), /&lt;p&gt;Becher&lt;\/p&gt;/, 'bisheriger Text bleibt erhalten');
  });
});

test('Fehler beim Veröffentlichen nimmt Geschriebenes sofort zurück (atomar)', async () => {
  await draft({ name: 'Kat', type: 'product_list', previewCategoryId: '4', sections: [{ blocks: [{ type: 'text', html: '<p>x</p>' }] }] });
  const before = fake.snapshot();
  const k = fake.categories.find(c => c.id === 4)!;
  allow = true;
  // Kategorie verschwindet zwischen Vorschlag und Freigabe
  const orig = s.emit;
  s.emit = ev => { if (ev.t === 'changeset') { fake.categories = fake.categories.filter(c => c.id !== 4); } orig(ev); };
  const r = await call('publish_page', { target: 'category', categoryId: '4' });
  s.emit = orig; fake.categories.push(k); fake.categories.sort((a, b) => a.id - b.id);
  assert.equal(r.status, 'failed', JSON.stringify(r));
  assert.equal(fake.snapshot(), before, 'Block wieder gelöscht');
});

test('CMS-Seiten lesen und ändern: Page Builder bleibt erhalten, Systemseiten gesperrt, Rückgängig exakt', async () => {
  const list = await call('list_cms_pages', {});
  assert.equal(list.total, 2); assert.equal(list.items[1].pageBuilder, true);
  const blocks = await call('list_cms_pages', { entity: 'block' });
  assert.equal(blocks.items[0].identifier, 'usp');
  const pg = await call('get_cms_page', { id: 'ueber-uns' });
  assert.match(pg.html, /<a href="\/alt.html">alt<\/a>/);
  await roundtrip('CMS-Seite', () => call('propose_cms_page_changes', { title: 'Link', reason: 'kaputt', changes: [{ id: '5', fields: { content: '<p>Wir sind <a href="/kueche.html">Küche</a></p>', metaDescription: 'Neu', title: 'Über uns neu', active: true } }] }), () => {
    const p = fake.cmsPages.find(x => x.id === 5)!;
    assert.ok(pb.isPageBuilder(String(p.content)), 'bleibt Page Builder'); assert.equal(p.meta_description, 'Neu'); assert.equal(p.identifier, 'ueber-uns', 'URL-Schlüssel bleibt beim neuen Titel');
  });
  const sys = await call('propose_cms_page_changes', { title: 'x', reason: 'x', changes: [{ id: 'no-route', fields: { title: 'Weg' } }] });
  assert.match(sys.error, /Systemseite/);
});

test('read_page: nur eigener Shop', async () => {
  assert.match((await call('read_page', { url: 'https://fremd.test/x' })).error, /nur Seiten des eigenen Shops/);
});

test('Shop-Check: Magento-Prüfungen mit Befunden und Magento-Werkzeugen im Auftrag', async () => {
  await magento.loadChecks();
  const checks = listChecks('magento').filter(c => c.id.startsWith('magento.'));
  assert.ok(checks.length >= 12);
  const ro = magentoReaderFor('shop-check');
  const run = await runChecks(ro as never, checks, { perRun: false, ctx: r => ({ platform: 'magento', reader: r, lookup: magento.lookup(r) }) });
  assert.deepEqual(run.errors, []);
  const by = (id: string) => run.findings.find(f => f.id === id);
  assert.equal(by('seo.product-meta-description-missing')?.count, 3); // BECHER, KERZE, SCHALE (AUS ist deaktiviert)
  assert.match(by('seo.product-meta-description-missing')!.fixPrompt, /seo_audit.*propose_product_changes/);
  assert.equal(by('preise.price-zero')?.sample?.[0]?.id, '3', 'KERZE: regulär 0, der höhere Sonderpreis wirkt nicht');
  assert.equal(by('preise.special-not-below')?.count, 2); // KERZE (5 ≥ 0) und SCHALE (35 ≥ 30)
  assert.equal(by('daten.stock-zero-orderable')?.sample?.[0]?.label, 'Becher (BECHER)');
  assert.match(by('links.product-description')?.sample?.[0]?.label ?? '', /Vase \(VASE\): Ziel nicht gefunden/);
  assert.match(by('links.cms-broken')?.sample?.[0]?.label ?? '', /Über uns.*Kategorie ist inaktiv/);
  assert.equal(by('seo.category-meta-description-missing')?.count, 1);
  assert.match(by('bilder.product-without-image')!.fixPrompt, /find_image_gaps/);
  assert.ok(by('sprachen.missing-translation.en'), 'Store-View en (en_US) ohne Übersetzung');
  for (const f of run.findings) assert.doesNotMatch(f.fixPrompt, /find_products_by_data|get_product_details|suggest_internal_links|Einkaufswelt|Shopware/, f.id);
});

test('Import: Plan (neu als Entwurf, nur geänderte Felder, Preise nur mit Option, Varianten übersprungen) und Rückgängig exakt', async () => {
  const csv = 'SKU;Name;Preis;UVP;Bestand;Beschreibung;Kategorie;Hauptartikel\nVASE;Vase neu;49,00;;10;;Wohnaccessoires;\nNEU-1;Neue Schale;29,90;39,90;5;Schöne Schale;Küche;\nNEU-2;Ohne Preis;;;;;;\nVAR-1;Variante;10;;;;;VASE\n';
  const t = await parseTable(Buffer.from(csv), 'liste.csv');
  const mapping = { productNumber: 'SKU', name: 'Name', priceGross: 'Preis', listPrice: 'UVP', stock: 'Bestand', description: 'Beschreibung', category: 'Kategorie', parentNumber: 'Hauptartikel' };
  const recs = readRecords(t, mapping);
  const cat = { products: [fake.products[0]].map(p => ({ id: p.id, sku: p.sku, name: 'Vase', type_id: 'simple', price: 49, custom_attributes: [] as { attribute_code: string; value: unknown }[], extension_attributes: { category_links: [{ category_id: '3' }] }, media_gallery_entries: [{ id: 1 }] })), categories: [{ id: '3', path: ['Wohnaccessoires'] }, { id: '4', path: ['Küche'] }], attributes: [], taxClasses: [{ label: 'Taxable Goods', value: '2' }], attributeSetId: 4, websiteIds: [1], stock: { source: 'default' }, stockBySku: { VASE: { quantity: 10, status: 1 } }, basis: 'gross' as const, takenUrlKeys: [] };
  const plan = planMagentoImport(recs, mapping, cat as never, {}, { title: 'T', reason: '', fileName: 'liste.csv', nextOffset: null });
  assert.equal(plan.stats.create, 1); assert.equal(plan.stats.update, 1);
  const create = plan.payload.plans.find(p => p.kind === 'create')!;
  assert.equal(create.kind === 'create' && create.product.price, 39.9, 'UVP = regulärer Preis'); assert.equal(create.kind === 'create' && create.product.extra?.special_price, 29.9);
  assert.equal(create.kind === 'create' && create.product.active, false);
  const upd = plan.payload.plans.find(p => p.kind === 'update')!;
  assert.deepEqual(upd.kind === 'update' && upd.scoped, { name: 'Vase neu' }, 'nur Name, Preis/Bestand ohne Option nicht');
  assert.ok(plan.cs.skipped.some(x => /Variante/.test(x.reason)) && plan.cs.skipped.some(x => /Preis fehlt/.test(x.reason)));

  // aktiver Sonderpreis + nur Preis in der Datei: der Dateipreis wird Sonderpreis, regulär 100 bleibt Streichpreis
  const sale = { ...cat, products: [{ ...cat.products[0], price: 100, custom_attributes: [{ attribute_code: 'special_price', value: '80' }] }], stockBySku: { VASE: { quantity: 5, status: 1 } } };
  const pm = { productNumber: 'SKU', priceGross: 'Preis', stock: 'Bestand' };
  const one = async (row: string) => planMagentoImport(readRecords(await parseTable(Buffer.from(`SKU;Preis;Bestand\n${row}\n`), 'x.csv'), pm), pm, sale as never, { updatePrices: true, updateStock: true }, { title: 'T', reason: '', fileName: 'x.csv', nextOffset: null });
  const p90 = await one('VASE;90;5'), u90 = p90.payload.plans[0];
  assert.deepEqual(u90.kind === 'update' && u90.global, { special_price: 90, special_from_date: null });
  assert.deepEqual(u90.kind === 'update' && u90.expect, { special_price: 80, special_from_date: null });
  assert.equal(p90.cs.sample![0].after, 'Preis: 90,00 € statt 100,00 €', 'Karte zeigt, was Magento verkauft');
  const u120 = (await one('VASE;120;5')).payload.plans[0];
  assert.deepEqual(u120.kind === 'update' && u120.global, { price: 120, special_price: null }, 'Preis ab Streichpreis: Sonderpreis entfällt');
  await assert.rejects(one('VASE;80;5'), /1 unverändert/, 'gleicher Verkaufspreis: nichts zu tun');
  assert.ok((await one('VASE;80;0')).cs.sample![0].warn.some(w => /Bestand 0, Status bleibt/.test(w)), 'Bestand 0 bleibt bestellbar: Warnung');

  // Ende-zu-Ende über das Werkzeug gegen den Fake
  const f = saveFile(Buffer.from(csv), 'liste.csv');
  const prev = await call('preview_import', { fileId: f.fileId, mapping, options: { updatePrices: true, updateStock: true } });
  assert.equal(prev.stats.create, 1); assert.equal(prev.stats.update, 1);
  await roundtrip('Import', () => call('propose_import', { fileId: f.fileId, title: 'Import', reason: 'Lieferant', mapping, options: { updatePrices: true, updateStock: true } }), () => {
    const n = fake.products.find(p => p.sku === 'NEU-1')!;
    assert.ok(n, 'angelegt'); assert.equal(n.vals[0].status, 2, 'Entwurf'); assert.equal(n.vals[0].price, 39.9); assert.equal(n.vals[0].special_price, 29.9);
    assert.equal(fake.sourceItems.find(x => x.sku === 'NEU-1')?.quantity, 5);
    assert.ok(fake.categories.find(c => c.id === 4)!.products.some(l => l.sku === 'NEU-1'));
    assert.equal(fake.products.find(p => p.sku === 'VASE')!.vals[0].name, 'Vase neu');
  });
});

test('Prompt: Magento-Seiten, Import und CMS ohne fremde Begriffe', () => {
  const p = buildBasePrompt('magento');
  assert.doesNotMatch(p, /\{\{\w+\}\}|Shopware|Einkaufswelt|noch nicht verfügbar|Produktseiten-Layouts \(product_detail\) gibt es/);
  assert.match(p, /## So funktionieren Seiten in Magento/); assert.match(p, /## Import aus Lieferantendaten/); assert.match(p, /propose_cms_page_changes/);
  assert.match(p, /seo_audit, find_image_gaps, list_products, get_cms_page/);
  for (const line of p.split('\n').filter(l => /Magento/.test(l))) assert.doesNotMatch(line, /—/);
});

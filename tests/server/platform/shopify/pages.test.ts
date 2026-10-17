// Shopify pages against the local Admin GraphQL fake: theme templates (pure), publishing landing page, collection and product template,
// theme without write access, errors midway. Every publication is undone and the fake state (incl. theme files) compared exactly.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatEvent, UndoOp } from '@/lib/protocol';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-shopify-pages-'));
delete process.env.SHOP_PLATFORM;

const { startFakeShopify } = await import('../../../support/shopify-fake/server');
const fake = await startFakeShopify({ port: 0 });
after(() => fake.close());

const { updateSettings } = await import('../../../../src/server/settings');
const { getSession, decideChange } = await import('../../../../src/server/sessions');
const { buildTools } = await import('../../../../src/server/tools');
const { getPlatform, reconfigureAll } = await import('../../../../src/server/platform/index');
const { stageImage } = await import('../../../../src/server/media');
const { renderPageParts } = await import('../../../../src/server/page-html');
const T = await import('../../../../src/server/platform/shopify/theme');

updateSettings({ platform: 'shopify', shopify: { storeDomain: fake.url, accessToken: fake.token, apiVersion: '2026-10' } });
reconfigureAll();
const shopify = getPlatform('shopify');
const P = { vase: '9100000000001', becher: '9100000000002', plaid: '9100000000003' }, C = { wohn: '480000000001' };
const MAIN = 'gid://shopify/OnlineStoreTheme/151000000001';

type Res = { isError?: boolean; content: { text: string }[] };
const session = getSession('chat-shopify-pages');
const events: ChatEvent[] = [];
session.emit = ev => { events.push(ev); session.events.push(ev); if (ev.t === 'changeset') setTimeout(() => decideChange(session.id, ev.approvalId, true), 0); };
const tools = buildTools(session);
const call = async (name: string, args: Record<string, unknown>) => (await tools.find(x => x.name === name)!.handler(args, {})) as Res;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (r: Res): any => { assert.equal(r.isError ?? false, false, r.content[0].text); return JSON.parse(r.content[0].text); };
const lastResult = () => [...events].reverse().find((e): e is Extract<ChatEvent, { t: 'changeset_result' }> => e.t === 'changeset_result')!;
const lastSet = () => [...events].reverse().find((e): e is Extract<ChatEvent, { t: 'changeset' }> => e.t === 'changeset')!.cs;
const theme = () => fake.state.themes.get(151000000001)!;
const file = (name: string) => fake.state.themeFileText(151000000001, name);

/** Fake state incl. theme files, without timestamps/counters (deep-equal before/after undo) */
function snap() {
  const s = JSON.parse(JSON.stringify(fake.state.snapshot()));
  const strip = (x: unknown): unknown => Array.isArray(x) ? x.map(strip) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).filter(([k]) => !['updatedAt', 'createdInRequest'].includes(k)).map(([k, v]) => [k, strip(v)])) : x;
  delete s.requestCount; delete s.stagedUploads; delete s.bulkOperations;
  return strip(s);
}
const undo = async (ops: UndoOp[]) => { const r = await shopify.undo(ops); assert.ok(r.every(x => x.ok), JSON.stringify(r)); };
const faq = { type: 'pattern', pattern: 'faq', data: { title: 'Häufige Fragen', items: [{ q: 'Ist die Vase spülmaschinenfest?', a: 'Nein, bitte von Hand spülen.' }, { q: 'Wie groß ist sie?', a: '22 cm hoch.' }] } };

test('templates (pure): Lotse sections before/after the main section, theme sections stay, reinserting replaces', () => {
  const coll = T.parseTemplate('/* Auto-generiert */\n{"sections":{"banner":{"type":"main-collection-banner","settings":{"x":1}},"product_grid":{"type":"main-collection-product-grid","settings":{"products_per_page":16},"blocks":{"a":{"type":"b"}},"block_order":["a"]},"news":{"type":"newsletter"}},"order":["banner","product_grid","news"],"wrapper":"div"}');
  const t = T.withLotseSections(coll, 'collection', { before: 'collection-wohn-before', after: 'collection-wohn-after' });
  assert.deepEqual(t.order, ['banner', 'lotse_before', 'product_grid', 'lotse_after', 'news']);
  assert.deepEqual(t.sections.product_grid, coll.sections.product_grid, 'theme section unchanged');
  assert.equal(t.wrapper, 'div');
  assert.deepEqual(t.sections.lotse_before, { type: 'lotse-content', settings: { key: 'collection-wohn-before' } });
  const again = T.withLotseSections(t, 'collection', { after: 'k' });
  assert.deepEqual(again.order, ['banner', 'product_grid', 'lotse_after', 'news'], 'old Lotse sections removed');
  const prod = T.withLotseSections({ sections: { main: { type: 'main-product' }, rec: { type: 'related-products' } }, order: ['main', 'rec'] }, 'product', { after: 'p' });
  assert.deepEqual(prod.order, ['main', 'lotse_after', 'rec']);
  assert.throws(() => T.withLotseSections({ sections: { a: { type: 'rich-text' } }, order: ['a'] }, 'product', { after: 'p' }), /keinen erkennbaren Hauptabschnitt/);
  assert.equal(T.mainSectionKey({ sections: { b: { type: 'main-collection-banner' }, g: { type: 'collection-grid' } }, order: ['b', 'g'] }, 'collection'), 'b');
  assert.throws(() => T.parseTemplate('{"sections":{}}'), /JSON-Vorlage/);
  assert.equal(T.templateSlug('Größe & Übersicht: Vasen!'), 'groesse-uebersicht-vasen');
  assert.ok(T.LOTSE_FILE.test('templates/collection.lotse-wohn.json') && T.LOTSE_FILE.test('sections/lotse-content.liquid'));
  for (const f of ['templates/collection.json', 'layout/theme.liquid', 'templates/collection.lotse-x.liquid', 'sections/header.liquid', 'templates/page.lotse-../x.json']) assert.ok(!T.LOTSE_FILE.test(f), f);
  assert.ok(T.metaKey('collection', 'x'.repeat(80), 'before').length <= 64);
  assert.match(T.SECTION_LIQUID, /shop\.metafields\.lotse\[key\]\.value/);
});

test('split HTML at the theme-main block: before/after, without theme-main everything before', () => {
  const ctx = { imageUrl: () => null, scope: 'lp-x' };
  const s = { name: 'x', type: 'product_list' as const, sections: [{ blocks: [{ type: 'text', html: '<h2>Oben</h2>' }, { type: 'theme-main' }, { type: 'text', html: '<p>Unten</p>' }] }, { blocks: [{ type: 'text', html: '<p>Ganz unten</p>' }] }] };
  const r = renderPageParts(s, ctx);
  assert.ok(r.themeMain); assert.match(r.before, /Oben/); assert.doesNotMatch(r.before, /Unten/); assert.match(r.after, /Unten[\s\S]*Ganz unten/);
  assert.match(r.before, /^<div class="lp-x"><style>/);
  const top = renderPageParts({ ...s, sections: [{ blocks: [{ type: 'theme-main' }, { type: 'text', html: '<p>U</p>' }] }] }, ctx);
  assert.equal(top.before, ''); assert.match(top.after, /<p>U<\/p>/);
  assert.throws(() => renderPageParts({ ...s, sections: [{ blocks: [{ type: 'product-listing' }] }] }, ctx), /product-listing/);
});

test('landing page: page + full-width template + uploaded image + real products; exact undo', async () => {
  const before = snap();
  const img = stageImage(Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4f10000000049454e44ae426082', 'hex'), 'image/png', { name: 'Vasen am Fenster', alt: 'Vasen am Fenster' });
  const d = await call('draft_page', { name: 'Ratgeber Vasen', type: 'landingpage', seo: { keyword: 'vasen', metaTitle: 'Vasen richtig kombinieren | Haus Holm Ratgeber', metaDescription: 'Welche Vase zu welchem Strauß passt: Formen, Höhen und Materialien im Überblick. Mit unseren Lieblingsstücken aus Keramik. Jetzt lesen.' },
    sections: [{ blocks: [{ type: 'text-hero', html: '<h1>Vasen richtig kombinieren</h1><p>Formen und Höhen für jeden Strauß.</p>' }, { type: 'image-text', image: { mediaId: img.mediaId, alt: 'Vasen am Fenster' }, html: '<p>Licht und Form.</p>' }, { type: 'product-slider', title: 'Unsere Vasen', productIds: [P.vase, P.plaid] }, faq] }] });
  assert.equal(d.isError ?? false, false, d.content[0].text);
  const bad = await call('publish_page', { target: 'landingpage', url: 'ueber-uns' });
  assert.equal(bad.isError, true); assert.match(bad.content[0].text, /schon vergeben/);
  const out = json(await call('publish_page', { target: 'landingpage', url: '/pages/Ratgeber Vasen' }));
  assert.equal(out.status, 'applied', JSON.stringify(out));
  const cs = lastSet();
  assert.ok(cs.items.some(i => i.fieldLabel === 'URL' && /\/pages\/ratgeber-vasen$/.test(i.after)));
  assert.equal(cs.assets?.length, 1, 'image is uploaded');
  const page = [...fake.state.pages.values()].find(p => p.handle === 'ratgeber-vasen')!;
  assert.ok(page, 'page created');
  assert.equal(page.templateSuffix, 'lotse-ratgeber-vasen');
  assert.match(page.body, /<h1>Vasen richtig kombinieren<\/h1>/);
  assert.match(page.body, /href="https:\/\/haus-holm\.myshopify\.com\/products\/vase-kiesel"/, 'product link with handle');
  assert.match(page.body, /Plaid „Düne“[\s\S]*89,00 €/, 'second product with price');
  assert.match(page.body, /application\/ld\+json/, 'FAQ schema');
  assert.match(page.body, /<img src="https?:\/\/[^"]+" alt="Vasen am Fenster"/, 'uploaded image with CDN URL');
  assert.doesNotMatch(page.body, /\/staged\//);
  assert.deepEqual(JSON.parse(file('templates/page.lotse-ratgeber-vasen.json')!), { sections: { main: { type: 'lotse-content', settings: { key: 'page' } } }, order: ['main'] });
  assert.equal(file('sections/lotse-content.liquid'), T.SECTION_LIQUID);
  const meta = fake.state.ownerMetafields(`gid://shopify/Page/${page.id}`);
  assert.ok(meta.some(m => m.key === 'title_tag' && m.value === 'Vasen richtig kombinieren | Haus Holm Ratgeber'));
  const res = lastResult();
  assert.equal(res.published?.storefront, 'https://haus-holm.myshopify.com/pages/ratgeber-vasen');
  await undo(res.undo!);
  assert.deepEqual(snap(), before, 'page, template, section and file removed');
  assert.equal(file('sections/lotse-content.liquid'), null);
});

test('collection: own template with theme sections + Lotse content above/below the product list, SEO; exact undo', async () => {
  const before = snap();
  const d = await call('draft_page', { name: 'Wohnaccessoires', type: 'product_list', previewCategoryId: C.wohn, seo: { keyword: 'wohnaccessoires', metaTitle: 'Wohnaccessoires aus Keramik und Wolle | Haus Holm', metaDescription: 'Vasen, Becher und Plaids für ein ruhiges Zuhause: handgemacht, langlebig und schlicht. Versand in 2 bis 3 Tagen. Jetzt die Kollektion ansehen.' },
    sections: [{ blocks: [{ type: 'text', html: '<p>Ruhige Stücke für jeden Raum.</p>' }, { type: 'theme-main' }, { type: 'text', html: '<h2>Wohnaccessoires pflegen</h2><p>Keramik von Hand spülen.</p>' }, faq] }] });
  assert.equal(d.isError ?? false, false, d.content[0].text);
  const draft = events.filter(e => e.t === 'draft').at(-1) as Extract<ChatEvent, { t: 'draft' }>;
  assert.match(String(draft.html), /Becher „Morgen“/, 'preview with real products of the collection');
  const out = json(await call('publish_page', { target: 'category', categoryId: C.wohn }));
  assert.equal(out.status, 'applied', JSON.stringify(out));
  const pubCs = (events.filter(e => e.t === 'changeset').at(-1) as Extract<ChatEvent, { t: 'changeset' }>).cs;
  assert.deepEqual(pubCs.measureTargets?.map(t => [t.entity, t.id]), [['category', '480000000001']], 'impact measurement: the collection whose template is replaced');
  const col = fake.state.collections.get(480000000001)!;
  assert.equal(col.templateSuffix, 'lotse-wohnaccessoires');
  assert.equal(col.seo.title, 'Wohnaccessoires aus Keramik und Wolle | Haus Holm');
  const tpl = JSON.parse(file('templates/collection.lotse-wohnaccessoires.json')!);
  assert.deepEqual(tpl.order, ['banner', 'lotse_before', 'product_grid', 'lotse_after']);
  assert.deepEqual(tpl.sections.product_grid, { type: 'main-collection-product-grid', settings: { products_per_page: 16 } }, 'product grid of the theme unchanged');
  const shopMeta = fake.state.ownerMetafields('gid://shopify/Shop/' + String((fake.state.shop as { id: number }).id));
  const html = (k: string) => shopMeta.find(m => m.namespace === 'lotse' && m.key === k)?.value ?? '';
  assert.match(html(tpl.sections.lotse_before.settings.key), /Ruhige Stücke/);
  assert.match(html(tpl.sections.lotse_after.settings.key), /Wohnaccessoires pflegen[\s\S]*FAQPage/);
  assert.equal(file('templates/collection.json'), theme().files.get('templates/collection.json')!.text, 'default template unchanged');
  // publish again (iteration): template is replaced, undo of the second run restores the first
  const first = snap(), res1 = lastResult();
  await call('draft_page', { name: 'Wohnaccessoires', type: 'product_list', sections: [{ blocks: [{ type: 'theme-main' }, { type: 'text', html: '<h2>Neu</h2>' }] }] });
  json(await call('publish_page', { target: 'category', categoryId: C.wohn }));
  assert.deepEqual(JSON.parse(file('templates/collection.lotse-wohnaccessoires.json')!).order, ['banner', 'product_grid', 'lotse_after']);
  await undo(lastResult().undo!);
  assert.deepEqual(snap(), first, 'second run exactly reverted');
  await undo(res1.undo!);
  assert.deepEqual(snap(), before, 'collection, template, metafields, section as before');
});

test('product template for several products; section stays while another Lotse template uses it', async () => {
  const before = snap();
  await call('draft_page', { name: 'Pflege Lp', type: 'landingpage', sections: [{ blocks: [{ type: 'text', html: '<h1>Pflege</h1>' }] }] });
  json(await call('publish_page', { target: 'landingpage', url: 'pflege' }));
  const lp = lastResult();
  const d = await call('draft_page', { name: 'Keramik', type: 'product_detail', previewProductId: P.vase, sections: [{ blocks: [{ type: 'theme-main' }, { type: 'pattern', pattern: 'usp-bar', data: { items: [{ title: 'Handgemacht', text: 'In Hamburg gedreht' }, { title: 'Versand', text: '2 bis 3 Tage' }, { title: 'Rückgabe', text: '30 Tage' }] } }, faq] }] });
  assert.equal(d.isError ?? false, false, d.content[0].text);
  const draft = events.filter(e => e.t === 'draft').at(-1) as Extract<ChatEvent, { t: 'draft' }>;
  assert.match(String(draft.html), /Vase „Kiesel“[\s\S]*49,00 €/, 'preview with a real product');
  const out = json(await call('publish_page', { target: 'product', productIds: [P.vase, P.becher], layout: 'Keramik' }));
  assert.equal(out.status, 'applied', JSON.stringify(out));
  assert.equal(fake.state.products.get(9100000000001)!.templateSuffix, 'lotse-keramik');
  assert.equal(fake.state.products.get(9100000000002)!.templateSuffix, 'lotse-keramik');
  assert.deepEqual(JSON.parse(file('templates/product.lotse-keramik.json')!).order, ['main', 'lotse_after']);
  const res = lastResult();
  assert.deepEqual(res.published?.storefront, ['https://haus-holm.myshopify.com/products/vase-kiesel', 'https://haus-holm.myshopify.com/products/becher-morgen']);
  await undo(lp.undo!); // revert landing page first: product template still uses the section
  assert.equal(file('sections/lotse-content.liquid'), T.SECTION_LIQUID, 'section stays (still in use)');
  await undo(res.undo!);
  assert.deepEqual(snap(), before);
});

test('theme without write access: landing page with default template, collection fails without traces (hint at mode description), description works', async () => {
  fake.options.themeWriteAccess = 'unpublished-only';
  try {
    const before = snap();
    await call('draft_page', { name: 'Ohne Theme', type: 'landingpage', sections: [{ blocks: [{ type: 'text', html: '<h1>Hallo</h1>' }] }] });
    json(await call('publish_page', { target: 'landingpage', url: 'ohne-theme' }));
    const res = lastResult(), page = [...fake.state.pages.values()].find(p => p.handle === 'ohne-theme')!;
    assert.equal(page.templateSuffix, null);
    assert.match(JSON.stringify(res.published), /Standardvorlage/);
    await undo(res.undo!);
    assert.deepEqual(snap(), before);

    await call('draft_page', { name: 'Wohn', type: 'product_list', sections: [{ blocks: [{ type: 'text', html: '<p>Oben</p>' }, { type: 'theme-main' }] }] });
    const r = json(await call('publish_page', { target: 'category', categoryId: C.wohn }));
    assert.equal(r.status, 'failed'); assert.match(JSON.stringify(lastResult()), /mode \\"description\\"|mode "description"/);
    assert.deepEqual(snap(), before, 'nothing written or everything reverted');

    json(await call('publish_page', { target: 'category', categoryId: C.wohn, mode: 'description' }));
    assert.match(fake.state.collections.get(480000000001)!.descriptionHtml, /Oben/);
    await undo(lastResult().undo!);
    assert.deepEqual(snap(), before);
  } finally { fake.options.themeWriteAccess = 'all'; }
});

test('error midway through publishing: all steps are reverted immediately', async () => {
  const before = snap();
  await call('draft_page', { name: 'Keramik', type: 'product_detail', sections: [{ blocks: [{ type: 'theme-main' }, { type: 'text', html: '<p>Pflege</p>' }] }] });
  // Product disappears between proposal and approval: assignment fails, template/metafields/section are removed
  let n = 0;
  session.emit = ev => { events.push(ev); session.events.push(ev); if (ev.t === 'changeset') { n++; fake.state.products.delete(9100000000003); setTimeout(() => decideChange(session.id, ev.approvalId, true), 0); } };
  try {
    const out = json(await call('publish_page', { target: 'product', productIds: [P.vase, P.plaid], layout: 'x' }));
    assert.equal(n, 1); assert.equal(out.status, 'failed');
    assert.match(String(lastResult().error ?? JSON.stringify(lastResult().results)), /nicht mehr vorhanden/);
    const now = snap() as { products: unknown[] }, was = before as { products: { id: number }[] };
    assert.deepEqual(now, { ...was, products: was.products.filter(p => p.id !== 9100000000003) }, 'theme, metafields, assignments unchanged (only the product deleted in the test is missing)');
  } finally {
    session.emit = ev => { events.push(ev); session.events.push(ev); if (ev.t === 'changeset') setTimeout(() => decideChange(session.id, ev.approvalId, true), 0); };
    fake.reset(); // restore the deleted test product
  }
});

test('undo: foreign theme files are locked, section deletion is idempotent', async () => {
  const r = await shopify.undo([{ op: 'req', entity: 'theme-file', id: MAIN, method: 'POST', path: 'graphql', body: { query: 'mutation ThemeFilesDelete($themeId: ID!, $files: [String!]!) { themeFilesDelete(themeId: $themeId, files: $files) { deletedThemeFiles { filename } userErrors { field message code filename } } }', variables: { themeId: MAIN, files: ['templates/product.json'] } } }]);
  assert.equal(r[0].ok, false); assert.match(String(r[0].error), /Ungültiger Rückgängig-Schritt/);
  assert.ok(file('templates/product.json'));
  const r2 = await shopify.undo([{ op: 'delete', entity: 'theme-section', id: MAIN, data: { filename: 'sections/lotse-content.liquid' } }]);
  assert.ok(r2[0].ok, JSON.stringify(r2));
});

const putFile = (name: string, text: string) => { const t = new Date().toISOString(); theme().files.set(name, { filename: name, text, base64: null, createdAt: t, updatedAt: t }); };

test('metafield key: unique per slug, even with the same prefix (max. 64 characters)', () => {
  const a = 'sommerkleider-aus-leinen-fuer-damen-grosse-blau', b = 'sommerkleider-aus-leinen-fuer-damen-grosse-rot';
  assert.notEqual(T.metaKey('collection', a, 'before'), T.metaKey('collection', b, 'before'));
  for (const s of [a, b, 'x'.repeat(50)]) assert.match(T.metaKey('collection', s, 'before'), /^[a-z0-9_-]{1,64}$/);
  assert.equal(T.metaKey('product', 'keramik', 'after'), 'product-keramik-after', 'short slugs as before');
});

test('base template (pure): own template, saved base of a Lotse template, content-identical template, mixed selection rejected', async () => {
  const { resolveBase, commonBase } = await import('../../../../src/server/platform/shopify/publish');
  const std = JSON.stringify({ sections: { main: { type: 'main-product', settings: {} } }, order: ['main'] });
  const pre = JSON.stringify({ sections: { main: { type: 'main-product', settings: { preorder: true } } }, order: ['main'] });
  const lotseOf = (base: string, file?: string) => T.templateText(T.withLotseSections(JSON.parse(base), 'product', { after: 'k' }, file));
  const files = new Map([['templates/product.json', std], ['templates/product.preorder.json', pre], ['templates/product.lotse-a.json', lotseOf(pre, 'templates/product.preorder.json')], ['templates/product.lotse-alt.json', lotseOf(pre)], ['templates/product.lotse-fremd.json', lotseOf(JSON.stringify({ sections: { m: { type: 'main-product', settings: { x: 1 } } }, order: ['m'] }))]]);
  assert.equal(resolveBase(files, 'product', null).file, 'templates/product.json');
  assert.equal(resolveBase(files, 'product', 'gibts-nicht').file, 'templates/product.json', 'missing template: Shopify shows the default template');
  assert.equal(resolveBase(files, 'product', 'lotse-a').file, 'templates/product.preorder.json', 'saved base');
  assert.equal(resolveBase(files, 'product', 'lotse-alt').file, 'templates/product.preorder.json', 'older Lotse template: content-identical template');
  assert.deepEqual([resolveBase(files, 'product', 'lotse-fremd').known, resolveBase(files, 'product', 'lotse-fremd').file], [false, 'templates/product.lotse-fremd.json']);
  assert.equal(commonBase(files, 'product', [{ title: 'A', templateSuffix: 'preorder' }, { title: 'B', templateSuffix: 'lotse-a' }], 'lotse-neu').file, 'templates/product.preorder.json');
  assert.throws(() => commonBase(files, 'product', [{ title: 'A', templateSuffix: 'preorder' }, { title: 'B', templateSuffix: null }], 'lotse-neu'), /unterschiedliche Basisvorlagen.*product\.preorder\.json: A.*product\.json: B/);
  assert.throws(() => commonBase(files, 'product', [{ title: 'B', templateSuffix: null }], 'lotse-a'), /vorhandene Vorlage templates\/product\.lotse-a\.json basiert auf templates\/product\.preorder\.json/);
});

test('product template: own base template is kept, mixed selection is rejected (before writing); exact undo', async () => {
  putFile('templates/product.preorder.json', JSON.stringify({ sections: { main: { type: 'main-product', settings: { preorder: true } } }, order: ['main'] }, null, 2));
  fake.state.products.get(9100000000001)!.templateSuffix = 'preorder';
  try {
    const before = snap();
    await call('draft_page', { name: 'Vorbestellung', type: 'product_detail', sections: [{ blocks: [{ type: 'theme-main' }, { type: 'text', html: '<p>Lieferung im Mai</p>' }] }] });
    // Vase (preorder) + mug (default): the proposal itself is rejected
    const mixed = await call('publish_page', { target: 'product', productIds: [P.vase, P.becher], layout: 'vorbestellung' });
    assert.equal(mixed.isError, true); assert.match(mixed.content[0].text, /unterschiedliche Produktvorlagen/);
    // only the vase: template from product.preorder.json, base noted in the Lotse sections, card names the base
    const out = json(await call('publish_page', { target: 'product', productIds: [P.vase], layout: 'vorbestellung' }));
    assert.equal(out.status, 'applied', JSON.stringify(out));
    assert.ok(lastSet().items.some(i => /Basis: templates\/product\.preorder\.json/.test(i.after)), JSON.stringify(lastSet().items));
    const tpl = JSON.parse(file('templates/product.lotse-vorbestellung.json')!);
    assert.deepEqual(tpl.sections.main.settings, { preorder: true }, 'settings of the own template stay');
    assert.equal(tpl.sections.lotse_after.settings.base, 'templates/product.preorder.json');
    const first = lastResult();
    // Vase (now lotse-vorbestellung, base preorder) + mug (default): only the executor knows the base and writes nothing
    const snapMid = snap();
    const r = json(await call('publish_page', { target: 'product', productIds: [P.vase, P.becher], layout: 'gemischt' }));
    assert.equal(r.status, 'failed'); assert.match(JSON.stringify(lastResult()), /unterschiedliche Basisvorlagen/);
    assert.deepEqual(snap(), snapMid, 'nothing written');
    await undo(first.undo!);
    assert.deepEqual(snap(), before);
  } finally { fake.reset(); }
});

test('target does not match the draft type: rejected', async () => {
  await call('draft_page', { name: 'Lp', type: 'landingpage', sections: [{ blocks: [{ type: 'text', html: '<h1>Hallo</h1>' }] }] });
  const r = await call('publish_page', { target: 'product', productIds: [P.vase], layout: 'x' });
  assert.equal(r.isError, true); assert.match(r.content[0].text, /passt nicht zu target=product/);
});

test('section deletion reads all theme files page by page: usage on a later page protects the section', async () => {
  try {
    putFile(T.SECTION_FILE, T.SECTION_LIQUID);
    for (let i = 0; i < 300; i++) putFile(`templates/page.extra-${String(i).padStart(3, '0')}.json`, JSON.stringify({ sections: { m: { type: 'main-page' } }, order: ['m'] }));
    putFile('templates/product.zz-hand.json', JSON.stringify({ sections: { m: { type: 'main-product' }, l: { type: 'lotse-content', settings: { key: 'x' } } }, order: ['m', 'l'] }));
    const r = await shopify.undo([{ op: 'delete', entity: 'theme-section', id: MAIN, data: { filename: T.SECTION_FILE } }]);
    assert.ok(r[0].ok, JSON.stringify(r));
    assert.equal(file(T.SECTION_FILE), T.SECTION_LIQUID, 'section stays: a template after page 1 uses it');
    theme().files.delete('templates/product.zz-hand.json');
    await shopify.undo([{ op: 'delete', entity: 'theme-section', id: MAIN, data: { filename: T.SECTION_FILE } }]);
    assert.equal(file(T.SECTION_FILE), null, 'unused: deleted');
  } finally { fake.reset(); }
});

test('lost response when creating the page (pageCreate): page is found by handle and reverted immediately, no orphaned page', async () => {
  const { applyShopifyPublish } = await import('../../../../src/server/platform/shopify/publish');
  const { ShopifyClient } = await import('../../../../src/server/platform/shopify/client');
  type PageSpec = import('../../../../src/server/cms').PageSpec; type ChangeSet = import('@/lib/protocol').ChangeSet;
  const conf = () => ({ origin: fake.url, domain: '127.0.0.1', apiVersion: '2026-10', token: fake.token, publicUrl: '', endpoint: `${fake.url}/admin/api/2026-10/graphql.json` });
  const lost = (root: string) => new ShopifyClient(conf, { fetch: async (u, i) => {
    if (typeof i?.body === 'string' && new RegExp(`\\b${root}\\(`).test(JSON.parse(i.body).query)) { await fetch(u, i); throw new Error('Zeitlimit (Test)'); }
    return fetch(u, i);
  } });
  const spec: PageSpec = { name: 'Verloren', type: 'landingpage', sections: [{ blocks: [{ type: 'text', html: '<p>Hallo</p>' }] }] };
  const cs: ChangeSet = { id: 'cs-verloren', kind: 'page', title: 't', reason: null, items: [{ id: 'i0', entity: 'info', label: 'x', fieldLabel: 'x', before: '', after: '', warn: [] }], skipped: [], atomic: true };
  for (const root of ['pageCreate', 'themeFilesUpsert']) {
    const before = snap();
    const r = await applyShopifyPublish(lost(root), cs, { spec, target: 'landingpage', mode: 'theme', slug: 'verloren', title: 'Verloren', published: true }, { sleep: async () => {} });
    assert.match(String(r.error), /Zeitlimit/); assert.match(String(r.error), /Alle bereits ausgeführten Schritte wurden zurückgenommen/, root);
    assert.deepEqual(r.undo, []);
    assert.ok(![...fake.state.pages.values()].some(p => p.handle === 'verloren'), `${root}: no orphaned page`);
    assert.deepEqual(snap(), before, `${root}: page, template and section reverted`);
  }
});

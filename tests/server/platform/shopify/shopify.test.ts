// Shopify-Adapter gegen den lokalen Admin-GraphQL-Fake (tests/support/shopify-fake): Client, geschützter Reader, Werkzeuge,
// Änderungssets (anwenden + Rückgängig stellt den Fake-Zustand exakt wieder her), Lookup.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatEvent, UndoOp } from '@/lib/protocol';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-shopify-'));
delete process.env.SHOP_PLATFORM;

const { startFakeShopify } = await import('../../../support/shopify-fake/server');
const fake = await startFakeShopify({ port: 0 });
after(() => fake.close());

const { updateSettings } = await import('../../../../src/server/settings');
const { accessList } = await import('../../../../src/server/db');
const { getSession, decideChange } = await import('../../../../src/server/sessions');
const { buildTools, toolNamesFor } = await import('../../../../src/server/tools');
const { getPlatform, reconfigureAll } = await import('../../../../src/server/platform/index');
const { ShopifyClient, shopifyOrigin, toGid, shortId } = await import('../../../../src/server/platform/shopify/client');
const { ShopifyReader, rootFields } = await import('../../../../src/server/platform/shopify/reader');
type Q = import('../../../../src/server/platform/shopify/data').Q;
const { stageImage } = await import('../../../../src/server/media');
const { DeniedError } = await import('../../../../src/server/policy');

updateSettings({ platform: 'shopify', shopify: { storeDomain: fake.url, accessToken: fake.token, apiVersion: '2026-10' } });
reconfigureAll();
const shopify = getPlatform('shopify');

const P = { vase: '9100000000001', becher: '9100000000002', plaid: '9100000000003' }, C = { wohn: '480000000001', keramik: '480000000002' };

type Res = { isError?: boolean; content: { text: string }[] };
const session = getSession('chat-shopify');
const events: ChatEvent[] = [];
let decide: boolean | ((cs: Extract<ChatEvent, { t: 'changeset' }>['cs']) => string[] | boolean) = true;
session.emit = ev => {
  events.push(ev); session.events.push(ev);
  if (ev.t === 'changeset') setTimeout(() => { const d = typeof decide === 'function' ? decide(ev.cs) : decide; decideChange(session.id, ev.approvalId, d !== false, Array.isArray(d) ? d : undefined); }, 0);
};
const tools = buildTools(session);
const call = async (name: string, args: Record<string, unknown>) => {
  const t = tools.find(x => x.name === name); assert.ok(t, `Werkzeug ${name} fehlt`);
  return (await t.handler(args, {})) as Res;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (r: Res): any => { assert.equal(r.isError ?? false, false, r.content[0].text); return JSON.parse(r.content[0].text); };
const lastResult = () => [...events].reverse().find((e): e is Extract<ChatEvent, { t: 'changeset_result' }> => e.t === 'changeset_result')!;
const lastSet = () => [...events].reverse().find((e): e is Extract<ChatEvent, { t: 'changeset' }> => e.t === 'changeset')!.cs;

/** Fake-Zustand ohne Zeitstempel/Zähler (für Deep-Equal vor/nach Rückgängig) */
function snap() {
  const s = JSON.parse(JSON.stringify(fake.state.snapshot()));
  const strip = (x: unknown): unknown => Array.isArray(x) ? x.map(strip) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).filter(([k]) => !['updatedAt', 'createdInRequest'].includes(k)).map(([k, v]) => [k, strip(v)])) : x;
  delete s.requestCount; delete s.stagedUploads; delete s.bulkOperations; delete s.themes;
  s.translations.sort((a: { resourceId: string; key: string; locale: string }, b: typeof a) => `${a.resourceId}${a.key}${a.locale}`.localeCompare(`${b.resourceId}${b.key}${b.locale}`));
  return strip(s);
}
const undo = async (ops: UndoOp[]) => { const r = await shopify.undo(ops); assert.ok(r.every(x => x.ok), JSON.stringify(r)); };
/** Vorschlag → Freigabe → Ergebnis prüfen → Rückgängig → Zustand exakt wie vorher */
async function roundtrip(name: string, args: Record<string, unknown>, check: () => void | Promise<void>) {
  const before = snap();
  const out = json(await call(name, args));
  assert.equal(out.status, 'applied', JSON.stringify(out));
  const res = lastResult(); assert.ok(res.undo?.length, 'Rückgängig-Schritte vorhanden');
  assert.ok(res.undo!.every(o => o.platform === 'shopify'));
  await check();
  assert.notDeepEqual(snap(), before, 'Änderung sichtbar');
  await undo(res.undo!);
  assert.deepEqual(snap(), before, `${name}: Rückgängig stellt den Zustand exakt wieder her`);
  return out;
}

test('Einstellungen: Domain-Prüfung, IDs, Werkzeugnamen passen', () => {
  assert.equal(shopifyOrigin('mein-shop.myshopify.com'), 'https://mein-shop.myshopify.com');
  assert.equal(shopifyOrigin('https://Mein-Shop.myshopify.com/admin'), 'https://mein-shop.myshopify.com');
  assert.equal(shopifyOrigin('http://127.0.0.1:3601'), 'http://127.0.0.1:3601');
  assert.throws(() => shopifyOrigin('https://evil.example.com'), /myshopify/);
  assert.equal(toGid('Product', '12'), 'gid://shopify/Product/12');
  assert.equal(toGid('Product', 'gid://shopify/Product/12'), 'gid://shopify/Product/12');
  assert.throws(() => toGid('Product', 'gid://shopify/Customer/12'), /Customer/);
  assert.throws(() => toGid('Product', '1 OR 1'), /Ungültige ID/);
  assert.equal(shortId('gid://shopify/Product/12'), '12');
  assert.deepEqual(tools.map(t => t.name), toolNamesFor('shopify'));
  for (const n of shopify.toolNames) assert.ok(tools.some(t => t.name === n), n);
});

test('Prompts: Shopify-Abschnitte nennen nur Werkzeuge, die es gibt; keine offenen Platzhalter, keine fremden Plattformbegriffe', async () => {
  const { buildBasePrompt, promptRoot } = await import('../../../../src/server/prompt');
  const names = new Set(toolNamesFor('shopify')), dir = path.join(promptRoot(), 'shopify');
  for (const f of fs.readdirSync(dir)) {
    const t = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of t.matchAll(/\b((?:propose|get|list|search|find|preview|read|run|gsc|add|remove)_[a-z_]+|seo_audit|view_image|ask_user|draft_page|publish_page|import_image|generate_image|create_svg_image)\b/g)) assert.ok(names.has(m[1]), `${f}: ${m[1]} gibt es auf Shopify nicht`);
    assert.doesNotMatch(t, /Shopware|Einkaufswelt|Verkaufskanal|product-listing-Block nutzen/, f);
  }
  const p = buildBasePrompt('shopify');
  assert.doesNotMatch(p, /\{\{\w+\}\}/); assert.match(p, /## So funktioniert Shopify/); assert.match(p, /seo_audit, find_image_gaps, get_product_images/);
  // auch die Werkzeugbeschreibungen sprechen Shopify (keine Shopware-Begriffe wie Produktstreams)
  for (const t of tools) assert.doesNotMatch(String(t.description), /Produktstream|Shopware|Einkaufswelt|Verkaufskanal/, t.name);
  assert.doesNotMatch(p, /Produktstream/);
});

test('Verbindungstest, Health, URLs, Kontext-Auswahl', async () => {
  const t = await shopify.testConnection();
  assert.equal(t.ok, true); assert.match(t.message, /Verbunden mit Shopify \(Haus Holm, API 2026-10\)/);
  assert.ok(!t.message.includes(fake.token));
  assert.equal((await shopify.health()).ok, true);
  const u = await shopify.urls();
  assert.equal(u.storefront, 'https://haus-holm.myshopify.com'); assert.equal(u.paths.product, '/products/{id}');
  const cats = await shopify.context.categories();
  assert.deepEqual(cats.map(c => c.name).sort(), ['Keramik', 'Wohnaccessoires']);
  assert.equal(cats.find(c => c.name === 'Keramik')?.type, 'smart');
  const prods = await shopify.context.products({ term: 'Vase', categoryId: null });
  assert.equal(prods[0].id, P.vase); assert.equal(prods[0].number, 'HH-VASE-KIESEL');
  assert.equal((await shopify.context.products({ categoryId: C.keramik })).length, 2);
});

test('Client: 429 mit Retry-After und THROTTLED werden abgewartet und wiederholt', async () => {
  const waits: number[] = [];
  const c = new ShopifyClient(() => ({ origin: fake.url, domain: '127.0.0.1', apiVersion: '2026-10', token: fake.token, publicUrl: '', endpoint: `${fake.url}/admin/api/2026-10/graphql.json` }), { sleep: async ms => { waits.push(ms); } });
  fake.failNext({ status: 429, retryAfter: 2 });
  assert.equal((await c.gql<{ shop: { name: string } }>('{ shop { name } }')).shop.name, 'Haus Holm');
  assert.ok(waits.includes(2000), `Retry-After abgewartet: ${waits}`);
  fake.throttle.currentlyAvailable = 0;
  let tries = 0; const orig = fake.throttle.tryConsume.bind(fake.throttle);
  fake.throttle.tryConsume = (n: number) => { tries++; if (tries === 1) return false; return orig(n); };
  assert.equal((await c.gql<{ shop: { name: string } }>('{ shop { name } }')).shop.name, 'Haus Holm');
  assert.ok(tries >= 2, 'nach THROTTLED wiederholt');
  fake.throttle.tryConsume = orig; fake.throttle.currentlyAvailable = fake.throttle.maximumAvailable;
  const bad = new ShopifyClient(() => ({ origin: fake.url, domain: '127.0.0.1', apiVersion: '2026-10', token: 'shpat_falsch_0000000000', publicUrl: '', endpoint: `${fake.url}/admin/api/2026-10/graphql.json` }));
  await assert.rejects(bad.gql('{ shop { name } }'), (e: Error) => /HTTP 401/.test(e.message) && !e.message.includes('shpat_falsch'));
});

test('Reader: Kunden, Bestellungen, Mutationen, E-Mail und fremde IDs gesperrt; Bereiche wirken; Zugriffe protokolliert', async () => {
  const reader = session.reader as InstanceType<typeof ShopifyReader>;
  assert.ok(reader instanceof ShopifyReader);
  assert.ok(!Object.keys(reader).some(k => /client|token/i.test(k)), 'kein Client/Token als Eigenschaft');
  assert.ok(!JSON.stringify(reader).includes(fake.token));
  for (const doc of ['{ customers(first: 5) { nodes { id } } }', 'query { orders(first: 1) { nodes { id } } }', '{ draftOrders(first: 1) { nodes { id } } }', '{ abandonedCheckouts(first: 1) { nodes { id } } }',
    '{ staffMembers(first: 1) { nodes { id } } }', '{ shop { email } }', '{ shop { name contactEmail } }', 'mutation { productDelete(input: {id: "gid://shopify/Product/1"}) { deletedProductId } }',
    '{ a: shop { name } } { customers(first:1) { nodes { id } } }', '{ codeDiscountNodes(first: 1) { nodes { codeDiscount { ... on DiscountCodeBasic { customerSelection { __typename } } } } } }', '{ x: customers(first: 1) { nodes { id } } }'])
    await assert.rejects(reader.query(doc), DeniedError, doc);
  await assert.rejects(reader.query('query N($ids: [ID!]!) { nodes(ids: $ids) { id } }', { ids: ['gid://shopify/Customer/1'] }), DeniedError);
  await assert.rejects(reader.query('query N($ids: [ID!]!) { nodes(ids: $ids) { id } }', { ids: ['gid://shopify/Order/1'] }), DeniedError);
  assert.deepEqual(rootFields('query Q($a: Int) { p: products(first: $a) { nodes { id } } shop { name } }'), ['products', 'shop']);
  // Bereich „Medienbibliothek“ aus: Dateien und Produktbilder gesperrt, Produkte ohne Bilder lesbar
  updateSettings({ scopes: { media: false } });
  await assert.rejects(reader.query('{ files(first: 1) { nodes { id } } }'), /Medienbibliothek/);
  await assert.rejects(reader.query('{ products(first: 1) { nodes { id media(first: 1) { nodes { id } } } } }'), /Medienbibliothek/);
  assert.ok((await reader.query<{ products: { nodes: unknown[] } }>('{ products(first: 1) { nodes { id } } }')).products.nodes.length);
  updateSettings({ scopes: { media: true } });
  const log = accessList(200);
  assert.ok(log.some(l => l.op === 'deny' && /customers/.test(l.entity)), 'Ablehnung protokolliert');
  assert.ok(log.some(l => l.op === 'read' && l.entity === 'products' && l.chat === 'chat-shopify'), 'Lesen protokolliert');
});

test('Lese-Werkzeuge: Produkte, Kollektionen, Medien, Varianten, Sprachen, Rabatte, SEO', async () => {
  const s = json(await call('search_products', { term: 'Becher' }));
  assert.equal(s.total, 1); assert.equal(s.products[0].id, P.becher); assert.equal(s.products[0].price, '18,00 €'); assert.equal(s.products[0].manufacturer, 'Haus Holm');
  const p = json(await call('get_product', { id: P.becher }));
  assert.equal(p.variants.length, 4); assert.equal(p.variants.find((v: { compareAtPrice: number }) => v.compareAtPrice === 22).priceText, '18,00 €');
  assert.deepEqual(p.options.map((o: { name: string }) => o.name), ['Farbe', 'Größe']); assert.equal(p.images.length, 2); assert.equal(p.metaTitle, 'Becher Morgen – Steinzeug | Haus Holm');
  assert.deepEqual(p.categories.map((c: { name: string }) => c.name).sort(), ['Keramik', 'Wohnaccessoires']);
  assert.equal(json(await call('get_product', { id: P.vase })).images[0].alt, null);
  const l1 = json(await call('list_products', { limit: 2 }));
  assert.equal(l1.total, 3); assert.equal(l1.returned, 2); assert.ok(l1.nextCursor);
  const l2 = json(await call('list_products', { limit: 2, cursor: l1.nextCursor }));
  assert.equal(l2.returned, 1); assert.equal(l2.nextCursor, null);
  assert.equal(json(await call('list_products', { limit: 2, offset: 2 })).products[0].id, l2.products[0].id);
  assert.deepEqual(json(await call('list_products', { minPrice: 40, categoryId: C.wohn })).products.map((x: { name: string }) => x.name).sort(), ['Plaid „Düne“', 'Vase „Kiesel“']);
  assert.equal(json(await call('list_products', { tag: 'Textil' })).total, 1);
  const cats = json(await call('search_categories', {}));
  assert.equal(cats.length, 2);
  const k = json(await call('get_category', { id: C.keramik }));
  assert.equal(k.type, 'smart'); assert.equal(k.rule, 'Tag = Keramik'); assert.equal(k.products, 2);
  assert.ok(json(await call('search_media', {})).length >= 3);
  const v = json(await call('get_variants', { productId: P.becher }));
  assert.equal(v.variants.length, 4);
  assert.deepEqual(json(await call('list_languages', {})).map((l: { locale: string }) => l.locale), ['de', 'en']);
  const tr = json(await call('get_translations', { entity: 'product', ids: [P.becher], language: 'en' }));
  assert.equal(tr[0].fields.find((f: { field: string }) => f.field === 'name').translation, 'Mug “Morning”');
  assert.equal(json(await call('list_promotions', {})).returned, 0);
  const seo = json(await call('get_seo_urls', { productIds: [P.vase], categoryIds: [C.wohn] }));
  assert.deepEqual(seo.map((x: { url: string }) => x.url), ['https://haus-holm.myshopify.com/products/vase-kiesel', 'https://haus-holm.myshopify.com/collections/wohnaccessoires']);
  const audit = json(await call('seo_audit', { entity: 'product' }));
  assert.ok(audit.items.find((x: { id: string }) => x.id === P.vase).issues.includes('Meta-Title fehlt'));
  const gaps = json(await call('find_image_gaps', { missing: 'images' }));
  assert.deepEqual(gaps.products.map((x: { id: string }) => x.id), [P.plaid]);
  const alt = json(await call('find_image_gaps', { missing: 'alt' }));
  assert.equal(alt.found, 2);
  const pr = json(await call('preview_collection_rules', { rules: [{ column: 'TAG', relation: 'EQUALS', condition: 'Wohnen' }] }));
  assert.equal(pr.count, 2);
  assert.equal(json(await call('preview_bulk_filter', { collectionId: C.wohn, maxPrice: 50 })).count, 2);
});

test('Lookup: Produkte per ID/SKU, URLs der Search Console, Pfade, aktueller Stand', async () => {
  const lk = session.lookup;
  assert.deepEqual(await lk.findProducts({ ids: [P.vase], numbers: ['HH-PLAID-DUENE'] }), [{ id: P.vase, number: 'HH-VASE-KIESEL', name: 'Vase „Kiesel“' }, { id: P.plaid, number: 'HH-PLAID-DUENE', name: 'Plaid „Düne“' }]);
  assert.deepEqual(await lk.findCategories([C.wohn]), [{ id: C.wohn, name: 'Wohnaccessoires' }]);
  const g = await lk.getProduct(P.becher);
  assert.equal(g?.number, 'HH-BECHER-SAND-250'); assert.equal(g?.ean, '4260123450028'); assert.equal(g?.categoryIds.length, 2);
  assert.match(String(await lk.mediaUrl('32600000000001')), /vase-kiesel\.jpg/);
  const m = await lk.mapUrls(['https://haus-holm.myshopify.com/products/vase-kiesel', 'https://haus-holm.myshopify.com/en/collections/keramik', 'https://haus-holm.myshopify.com/', 'https://haus-holm.myshopify.com/pages/ueber-uns', 'https://haus-holm.myshopify.com/collections/wohnaccessoires/products/plaid-duene', 'https://haus-holm.myshopify.com/blogs/x'], { metas: true });
  assert.equal(m.get('https://haus-holm.myshopify.com/products/vase-kiesel')?.id, P.vase);
  assert.equal(m.get('https://haus-holm.myshopify.com/en/collections/keramik')?.kind, 'category');
  assert.equal(m.get('https://haus-holm.myshopify.com/')?.kind, 'home');
  assert.equal(m.get('https://haus-holm.myshopify.com/pages/ueber-uns')?.kind, 'landing');
  assert.equal(m.get('https://haus-holm.myshopify.com/collections/wohnaccessoires/products/plaid-duene')?.id, P.plaid);
  assert.equal(m.get('https://haus-holm.myshopify.com/blogs/x'), null);
  assert.deepEqual(await lk.entityPaths('product', P.vase), { paths: ['products/vase-kiesel'], urls: ['https://haus-holm.myshopify.com/products/vase-kiesel'] });
  assert.equal((await lk.current('product', P.becher))?.metaTitle, 'Becher Morgen – Steinzeug | Haus Holm');
});

test('Vorschau-Daten: Produkte aus Blöcken und Kollektion, Bilder per mediaId', async () => {
  const ctx = await shopify.pages.previewData(session, { name: 'x', type: 'product_list', previewCategoryId: C.keramik, sections: [{ blocks: [{ type: 'product-slider', productIds: [P.plaid] }, { type: 'image-cover', image: { mediaId: '32600000000001', alt: 'Vase' } }] }] });
  assert.equal(ctx.products?.[P.plaid]?.price, '89,00 €');
  assert.equal(ctx.products?.[P.becher]?.name, 'Becher „Morgen“', 'Produkte der Kollektion');
  assert.match(String(ctx.imageUrl?.({ mediaId: '32600000000001' })), /vase-kiesel\.jpg/);
  const r = await call('draft_page', { name: 'Keramik', type: 'product_list', previewCategoryId: C.keramik, sections: [{ blocks: [{ type: 'text', html: '<h2>Keramik</h2>' }, { type: 'theme-main' }, { type: 'product-slider', productIds: [P.vase] }] }] });
  assert.equal(r.isError ?? false, false, r.content[0].text);
  const ev = events.filter(e => e.t === 'draft').at(-1) as Extract<ChatEvent, { t: 'draft' }>;
  assert.match(String(ev.html), /Vase „Kiesel“/); assert.match(String(ev.html), /49,00 €/);
  assert.match(String(ev.html), /Produktliste des Themes/, 'theme-main zeigt die echte Produktliste der Kollektion');
});

test('Produktfelder: Name, SEO, Preisregel je Variante, Streichpreis, Tags, Status, FAQ: anwenden + exakt rückgängig', async () => {
  await roundtrip('propose_product_changes', { title: 'Test', reason: 'Test', changes: [
    { id: P.becher, fields: { price: { percent: -10, round: '.99' }, listPrice: null, metaDescription: 'Neu', tags: { add: ['Sale'] } } },
    { id: P.vase, fields: { name: 'Vase Kiesel', description: '<p>Neu</p>', metaTitle: 'Vase Kiesel | Haus Holm', active: false, faq: { items: [{ q: 'Spülmaschine?', a: 'Nein.' }, { q: 'Wasserdicht?', a: 'Ja.' }] }, ean: '4260000000000', sku: 'HH-VK' } },
  ] }, () => {
    const b = [...fake.state.variants.values()].filter(v => String(v.productId) === P.becher);
    assert.deepEqual(b.map(v => v.price), ['15.99', '15.99', '15.99', '15.99']);
    assert.ok(b.every(v => v.compareAtPrice === null));
    const vase = fake.state.products.get(Number(P.vase))!;
    assert.equal(vase.title, 'Vase Kiesel'); assert.equal(vase.status, 'DRAFT'); assert.equal(vase.seo.title, 'Vase Kiesel | Haus Holm'); assert.equal(vase.seo.description, null);
    assert.ok(fake.state.products.get(Number(P.becher))!.tags.includes('Sale'));
    assert.match(String(fake.state.findMetafield(toGid('Product', P.vase), 'lotse', 'faq')?.value), /Spülmaschine/);
    assert.equal([...fake.state.variants.values()].find(v => String(v.productId) === P.vase)!.barcode, '4260000000000');
  });
  const cs = lastSet();
  assert.ok(cs.items.some(i => i.field === 'price' && i.before === '18,00 € (4 Varianten)' && i.after === '15,99 € (4 Varianten)'), JSON.stringify(cs.items.map(i => [i.field, i.before, i.after])));
  // gesperrte/unbekannte Felder werden übersprungen, nicht geschrieben
  const bad = await call('propose_product_changes', { title: 'x', reason: 'x', changes: [{ id: P.vase, fields: { stock: 3, keywords: 'a' } }] });
  assert.equal(bad.isError, true); assert.match(bad.content[0].text, /nur lesbar/);
});

test('Teilfreigabe: nur ausgewählte Zeilen werden geschrieben', async () => {
  decide = cs => [cs.items.find(i => i.field === 'metaTitle')!.id];
  const before = fake.state.products.get(Number(P.plaid))!.title;
  const out = json(await call('propose_product_changes', { title: 't', reason: 'r', changes: [{ id: P.plaid, fields: { name: 'Plaid X', metaTitle: 'Plaid Düne | Haus Holm' } }] }));
  decide = true;
  assert.equal(out.status, 'applied');
  assert.equal(fake.state.products.get(Number(P.plaid))!.title, before);
  assert.equal(fake.state.products.get(Number(P.plaid))!.seo.title, 'Plaid Düne | Haus Holm');
  await undo(lastResult().undo!);
  assert.equal(fake.state.products.get(Number(P.plaid))!.seo.title, null);
});

test('Abgelehnt: nichts wird geschrieben', async () => {
  decide = false; const before = snap();
  const out = json(await call('propose_product_changes', { title: 't', reason: 'r', changes: [{ id: P.plaid, fields: { name: 'Nein' } }] }));
  decide = true;
  assert.equal(out.status, 'rejected'); assert.deepEqual(snap(), before);
});

test('Neue Produkte (Entwurf, Preis, SKU, Bild aus Upload, Kollektion): anlegen + rückgängig', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const st = stageImage(Buffer.concat([png, Buffer.alloc(40)]), 'image/png', { name: 'kanne', alt: 'Kanne in Sand' });
  await roundtrip('propose_new_products', { title: 'Neu', reason: 'Fotos', products: [{ name: 'Kanne „Ebbe“', description: '<p>Steinzeugkanne.</p>', price: 39, sku: 'HH-KANNE', images: [st.mediaId, '32600000000001'], collectionIds: [C.wohn], tags: ['Keramik'] }] }, () => {
    const p = [...fake.state.products.values()].find(x => x.title === 'Kanne „Ebbe“')!;
    assert.equal(p.status, 'DRAFT'); assert.equal(p.mediaIds.length, 2);
    const v = [...fake.state.variants.values()].find(x => x.productId === p.id)!;
    assert.equal(v.price, '39.00'); assert.equal(v.sku, 'HH-KANNE');
    assert.ok(fake.state.collections.get(Number(C.wohn))!.productIds.includes(p.id));
  });
  // Bild der Vase wurde nur verknüpft, nicht dupliziert; nach dem Rückgängig gibt es es noch
  assert.ok(fake.state.media.has(32600000000001));
  const noPrice = await call('propose_new_products', { title: 'x', reason: 'x', products: [{ name: 'X', description: '<p>x</p>', price: -1 }] });
  assert.equal(noPrice.isError, true); assert.match(noPrice.content[0].text, /nicht schätzen/);
});

test('Varianten: Preis je Variante, SKU, neue Variante: anwenden + rückgängig', async () => {
  await roundtrip('propose_variants', { title: 'V', reason: 'V', productId: P.becher, update: [{ id: '51200000000005', price: 24, listPrice: null, sku: 'HH-B-N' }], create: [{ options: { Farbe: 'Salbei', Größe: '350 ml' }, price: 19 }] }, () => {
    const v = fake.state.variants.get(51200000000005)!;
    assert.equal(v.price, '24.00'); assert.equal(v.compareAtPrice, null); assert.equal(v.sku, 'HH-B-N');
    assert.ok([...fake.state.variants.values()].some(x => String(x.productId) === P.becher && x.selectedOptions.map(o => o.value).join('/') === 'Salbei/350 ml'));
  });
  const def = await call('propose_variants', { title: 'V', reason: 'V', productId: P.vase, create: [{ options: { Farbe: 'Rot' } }] });
  assert.equal(def.isError, true); assert.match(def.content[0].text, /Optionen/);
});

test('Kollektionen: Texte, SEO, Sichtbarkeit, Sortierung: anwenden + rückgängig', async () => {
  await roundtrip('propose_category_changes', { title: 'K', reason: 'K', changes: [{ id: C.wohn, fields: { description: '<p>Neu</p>', metaTitle: 'Wohnaccessoires | Haus Holm', active: false, sortOrder: 'PRICE_ASC' } }] }, () => {
    const c = fake.state.collections.get(Number(C.wohn))!;
    assert.equal(c.descriptionHtml, '<p>Neu</p>'); assert.equal(c.published, false); assert.equal(c.sortOrder, 'PRICE_ASC'); assert.equal(c.seo.title, 'Wohnaccessoires | Haus Holm');
  });
});

test('Automatische Kollektion (Produktstream) anlegen, Regel ändern, Produkte zuordnen: rückgängig', async () => {
  await roundtrip('propose_collection', { title: 'S', reason: 'S', collections: [{ name: 'Wohnen bis 60 €', rules: [{ column: 'TAG', relation: 'EQUALS', condition: 'Wohnen' }, { column: 'VARIANT_PRICE', relation: 'LESS_THAN', condition: '60' }], publish: true }] }, () => {
    const c = [...fake.state.collections.values()].find(x => x.title === 'Wohnen bis 60 €')!;
    assert.equal(c.ruleSet?.rules.length, 2); assert.equal(c.published, true);
    assert.deepEqual(fake.state.collectionProducts(c).map(p => p.title), ['Vase „Kiesel“']);
  });
  assert.match(lastSet().items[0].after, /1 Treffer/);
  await roundtrip('propose_collection', { title: 'S', reason: 'S', collections: [{ id: C.keramik, rules: [{ column: 'TYPE', relation: 'EQUALS', condition: 'Vase' }], sortOrder: 'ALPHA_ASC' }] }, () => {
    assert.equal(fake.state.collections.get(Number(C.keramik))!.ruleSet?.rules[0].column, 'TYPE');
  });
  await roundtrip('propose_collection_products', { title: 'P', reason: 'P', collectionId: C.wohn, remove: [P.becher] }, () => {
    assert.ok(!fake.state.collections.get(Number(C.wohn))!.productIds.includes(Number(P.becher)));
  });
  const smart = await call('propose_collection_products', { title: 'P', reason: 'P', collectionId: C.keramik, add: [P.plaid] });
  assert.equal(smart.isError, true); assert.match(smart.content[0].text, /automatische Kollektion/);
});

test('Produktbilder (neu hochladen, verknüpfen, entfernen, Titelbild) und Alt-Texte: rückgängig', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000020000000208060000', 'hex');
  const st = stageImage(Buffer.concat([png, Buffer.alloc(40)]), 'image/png', { name: 'becher-salbei', alt: 'Becher in Salbei' });
  await roundtrip('propose_product_images', { title: 'B', reason: 'B', products: [{ productId: P.becher, add: [{ image: st.mediaId }, { image: '32600000000001' }], remove: ['32600000000002'], cover: '32600000000003' }] }, () => {
    const ids = fake.state.products.get(Number(P.becher))!.mediaIds;
    assert.equal(ids[0], 32600000000003, 'Titelbild'); assert.equal(ids.length, 3); assert.ok(!ids.includes(32600000000002)); assert.ok(ids.includes(32600000000001));
    assert.ok(fake.state.media.has(32600000000002), 'entferntes Bild bleibt als Datei');
  });
  // Alt-Text nur für angesehene Bilder
  const notSeen = await call('propose_alt_texts', { title: 'A', reason: 'A', images: [{ mediaId: '32600000000001', alt: 'Bauchige Vase aus hellem Steinzeug' }] });
  assert.equal(notSeen.isError, true); assert.match(notSeen.content[0].text, /view_image/);
  session.events.push({ t: 'tool', name: 'mcp__shop__view_image', input: { mediaId: '32600000000001' } } as unknown as ChatEvent);
  await roundtrip('propose_alt_texts', { title: 'A', reason: 'A', images: [{ mediaId: '32600000000001', alt: 'Bauchige Vase aus hellem Steinzeug' }] }, () => {
    assert.equal(fake.state.media.get(32600000000001)!.alt, 'Bauchige Vase aus hellem Steinzeug');
  });
});

test('Übersetzungen (neu + vorhandene überschreiben): rückgängig stellt beides wieder her', async () => {
  await roundtrip('propose_translations', { title: 'T', reason: 'T', entity: 'product', changes: [{ id: P.becher, language: 'en', fields: { name: 'Mug “Morning” (stoneware)', metaTitle: 'Morning mug | Haus Holm', handle: 'morning-mug' } }] }, () => {
    const t = fake.state.translations.filter(x => x.resourceId === toGid('Product', P.becher) && x.locale === 'en');
    assert.equal(t.find(x => x.key === 'title')?.value, 'Mug “Morning” (stoneware)'); assert.equal(t.find(x => x.key === 'handle')?.value, 'morning-mug');
  });
  const main = await call('propose_translations', { title: 'T', reason: 'T', entity: 'product', changes: [{ id: P.vase, language: 'de', fields: { name: 'x' } }] });
  assert.equal(main.isError, true); assert.match(main.content[0].text, /Hauptsprache/);
});

test('Rabattcode anlegen, ändern, beenden/aktivieren: jeweils exakt rückgängig', async () => {
  await roundtrip('propose_promotion', { reason: 'Herbst', title: 'Herbst 20 % Keramik', code: 'HERBST20', type: 'percentage', value: 20, collectionIds: [C.keramik], startsAt: '2026-10-01', endsAt: '2026-10-31', oncePerCustomer: true }, () => {
    const d = [...fake.state.discounts.values()][0];
    assert.equal(d.codes[0].code, 'HERBST20'); assert.deepEqual(d.value, { kind: 'percentage', percentage: 0.2 }); assert.equal(d.items.kind, 'collections'); assert.equal(d.appliesOncePerCustomer, true);
  });
  // dauerhaft anlegen (ohne Rückgängig) für Ändern/Status
  json(await call('propose_promotion', { reason: 'x', title: 'Sommer', code: 'SOMMER10', type: 'amount', value: 10, startsAt: '2026-01-01' }));
  const id = String([...fake.state.discounts.values()].find(d => d.title === 'Sommer')!.id);
  const list = json(await call('list_promotions', { status: 'active' }));
  assert.equal(list.promotions[0].codes[0], 'SOMMER10'); assert.equal(list.promotions[0].value, '10,00 €');
  await roundtrip('propose_promotion', { id, reason: 'länger', endsAt: '2026-12-31', usageLimit: 100, type: 'percentage', value: 15 }, () => {
    const d = fake.state.discounts.get(Number(id))!; assert.equal(d.usageLimit, 100); assert.deepEqual(d.value, { kind: 'percentage', percentage: 0.15 });
  });
  await roundtrip('propose_promotion_status', { ids: [id], action: 'deactivate' }, () => {
    assert.ok(fake.state.discounts.get(Number(id))!.endsAt);
  });
});

test('Rabatt ändern: nur angehakte Felder werden geschrieben, der Rest bleibt und gilt nicht als erledigt', async () => {
  const prev = decide, before = snap();
  let createdUndo: UndoOp[] | undefined, partialUndo: UndoOp[] | undefined;
  try {
    json(await call('propose_promotion', { reason: 'x', title: 'Auswahl', code: 'AUSWAHL1', type: 'amount', value: 10, startsAt: '2026-01-01', usageLimit: 3 }));
    createdUndo = lastResult().undo;
    const id = String([...fake.state.discounts.values()].find(d => d.title === 'Auswahl')!.id);
    const prior = structuredClone(fake.state.discounts.get(Number(id))!);
    decide = cs => cs.items.filter(i => i.field === 'title' || i.field === 'oncePerCustomer').map(i => i.id);
    const out = json(await call('propose_promotion', { id, reason: 'nur Name', title: 'Auswahl neu', usageLimit: 9, type: 'percentage', value: 40, oncePerCustomer: true }));
    const d = fake.state.discounts.get(Number(id))!;
    partialUndo = lastResult().undo;
    assert.equal(d.title, 'Auswahl neu');
    assert.equal(d.appliesOncePerCustomer, true);
    assert.equal(d.usageLimit, prior.usageLimit, 'nicht angehaktes Limit bleibt');
    assert.deepEqual(d.value, prior.value, 'nicht angehakter Rabattwert bleibt');
    const lines = lastResult().results ?? [];
    assert.deepEqual(lines.map(r => r.itemId).sort(), ['f:oncePerCustomer', 'f:title']);
    assert.ok(lines.every(r => r.ok), 'nur angehakte Zeilen sind erledigt');
    assert.equal(out.status, 'applied');
    decide = () => [];
    const n = fake.state.discounts.size;
    json(await call('propose_promotion', { reason: 'x', title: 'Nicht angehakt', code: 'NEIN1', type: 'percentage', value: 5 }));
    assert.equal(fake.state.discounts.size, n, 'ohne Haken wird nichts angelegt');
    assert.deepEqual(lastResult().results ?? [], []);
  } finally {
    decide = prev;
    if (partialUndo?.length) await undo(partialUndo);
    if (createdUndo?.length) await undo(createdUndo);
  }
  assert.deepEqual(snap(), before);
});

test('SEO-URL (Handle) ändern legt Weiterleitung an; Rückgängig entfernt sie und stellt den Handle wieder her', async () => {
  await roundtrip('propose_seo_urls', { title: 'U', reason: 'U', changes: [{ entity: 'product', id: P.plaid, slug: 'Plaid Düne Wolle' }, { entity: 'category', id: C.keramik, slug: 'keramik-steinzeug' }, { entity: 'page', id: '129000000001', slug: 'ueber-haus-holm' }] }, () => {
    assert.equal(fake.state.products.get(Number(P.plaid))!.handle, 'plaid-duene-wolle');
    assert.ok([...fake.state.redirects.values()].some(r => r.path === '/products/plaid-duene' && r.target === '/products/plaid-duene-wolle'));
    assert.ok([...fake.state.redirects.values()].some(r => r.path === '/pages/ueber-uns'));
  });
  const taken = await call('propose_seo_urls', { title: 'U', reason: 'U', changes: [{ entity: 'product', id: P.plaid, slug: 'vase-kiesel' }] });
  assert.equal(taken.isError, true); assert.match(taken.content[0].text, /vergeben/);
});

test('Stapel: Regel für alle Produkte eines Filters, Fortschritt, rückgängig', async () => {
  const progress: [number, number][] = [];
  const prevEmit = session.emit;
  session.emit = ev => { if (ev.t === 'changeset_progress') progress.push([ev.done, ev.total]); prevEmit(ev); };
  await roundtrip('propose_bulk_product_change', { title: 'Sale', reason: 'Herbst', filter: { collectionId: C.wohn }, change: { price: { percent: -20, round: '.99' }, listPrice: 'currentPrice', tags: { add: ['Sale'] } } }, () => {
    assert.equal(fake.state.variants.get(51200000000001)!.price, '38.99'); assert.equal(fake.state.variants.get(51200000000001)!.compareAtPrice, '49.00');
    assert.equal(fake.state.variants.get(51200000000006)!.price, '70.99');
  });
  session.emit = prevEmit;
  const cs = lastSet();
  assert.equal(cs.total, 3); assert.ok(cs.sample?.length);
  assert.deepEqual(progress.at(-1), [3, 3]);
  const empty = await call('propose_bulk_product_change', { title: 'x', reason: 'x', filter: {}, change: { active: false } });
  assert.equal(empty.isError, true);
});

test('Rückgängig: nur erlaubte Mutationen, gelöschtes Objekt gilt als erledigt', async () => {
  const r = await shopify.undo([{ op: 'req', entity: 'x', id: '1', method: 'POST', path: 'graphql', body: { query: 'mutation { customerCreate(input: {}) { customer { id } } }', variables: {} }, platform: 'shopify' }]);
  assert.equal(r[0].ok, false); assert.match(String(r[0].error), /Ungültiger Rückgängig-Schritt/);
  assert.deepEqual(await shopify.undo([{ op: 'delete', entity: 'product', id: 'gid://shopify/Product/1', platform: 'shopify' }]), [{ ok: true }]);
});

test('Abfragekosten: Werkzeuge mit Höchstwerten bleiben unter 1000 (Shopify-Grenze je Abfrage)', async () => {
  const runs: [string, Record<string, unknown>][] = [['list_products', { limit: 500 }], ['list_products', { limit: 500, details: true }], ['search_products', { limit: 500 }], ['search_categories', { limit: 500 }],
    ['seo_audit', { entity: 'product', limit: 500 }], ['seo_audit', { entity: 'category', limit: 500 }], ['find_image_gaps', { missing: 'alt' }], ['list_promotions', { limit: 500 }], ['get_product', { id: P.becher }],
    ['get_category', { id: C.wohn }], ['get_product_images', { productIds: Array.from({ length: 50 }, (_, i) => String(9100000000001 + i)) }], ['search_media', { limit: 500 }]];
  for (const [name, args] of runs) { const r = await call(name, args); assert.equal(r.isError ?? false, false, `${name}: ${r.content[0].text.slice(0, 200)}`); }
  // viele IDs: Abfragen werden in Pakete geteilt (Vorschlag wird abgelehnt)
  decide = false;
  const r = json(await call('propose_product_changes', { title: 't', reason: 'r', changes: Array.from({ length: 30 }, (_, i) => ({ id: String(9100000000001 + i), fields: { name: 'X' } })) }));
  decide = true;
  assert.equal(r.status, 'rejected');
});

test('Großer Katalog: Stapel über viele Seiten (Paginierung), Fortschritt, exakt rückgängig', async () => {
  fake.throttle.restoreRate = 1000; // Shopify Plus (Standard 100/s: gleicher Ablauf, nur langsamer)
  for (let i = 0; i < 140; i++) fake.state.addProduct({ title: `Serie ${i}`, tags: ['Serie'], vendor: 'Haus Holm', variants: [{ price: String(10 + (i % 7)), sku: `S-${i}` }] });
  assert.equal(json(await call('preview_bulk_filter', { tag: 'Serie' })).count, 140);
  const l = json(await call('list_products', { tag: 'Serie', limit: 50, offset: 100 }));
  assert.equal(l.returned, 40); assert.equal(l.total, 140);
  const progress: [number, number][] = [], prevEmit = session.emit;
  session.emit = ev => { if (ev.t === 'changeset_progress') progress.push([ev.done, ev.total]); prevEmit(ev); };
  await roundtrip('propose_bulk_product_change', { title: 'Serie +5 %', reason: 'Preise', filter: { tag: 'Serie' }, change: { price: { percent: 5 }, active: false } }, () => {
    assert.ok([...fake.state.products.values()].filter(p => p.tags.includes('Serie')).every(p => p.status === 'DRAFT'));
  });
  session.emit = prevEmit;
  assert.equal(lastSet().total, 140); assert.equal(lastSet().sample?.length, 50);
  assert.deepEqual(progress.at(-1), [140, 140]);
  assert.equal(lastResult().counts?.applied, 140);
  fake.throttle.restoreRate = 100;
});

test('Drosselung: leerer Kosten-Bucket, Lesen und viele Schreibzugriffe parallel: alles kommt an (warten statt scheitern)', async () => {
  Object.assign(fake.throttle, { maximumAvailable: 1000, restoreRate: 500 }); fake.throttle.currentlyAvailable = 0;
  await roundtrip('propose_product_changes', { title: 't', reason: 'r', changes: [P.vase, P.becher, P.plaid].map(id => ({ id, fields: { price: { add: 1 }, metaTitle: 'Titel für Drosseltest', tags: { add: ['Drossel'] } } })) }, () => {
    assert.ok([...fake.state.products.values()].filter(p => p.tags.includes('Drossel')).length === 3);
  });
  Object.assign(fake.throttle, { maximumAvailable: 2000, currentlyAvailable: 2000, restoreRate: 100 });
});

// ---- Exaktes Rückgängig auch bei Teilfehlern, App-Zugang (Client-Credentials-Grant), veraltete Stapel, Kleinigkeiten ----
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = Record<string, any>;
const conf = () => ({ origin: fake.url, domain: '127.0.0.1', apiVersion: '2026-10', token: fake.token, publicUrl: '', endpoint: `${fake.url}/admin/api/2026-10/graphql.json` });
/** Client, dessen fetch bei einer Mutation (Root-Feld) dazwischenfunkt: 'user' = userErrors (nichts geändert), 'lost' = ausgeführt, Antwort geht verloren */
function faultyClient(root: string, mode: 'user' | 'lost') {
  return new ShopifyClient(conf, { fetch: async (u, i) => {
    if (typeof i?.body === 'string' && new RegExp(`\\b${root}\\(`).test(JSON.parse(i.body).query)) {
      if (mode === 'user') return new Response(JSON.stringify({ data: { [root]: { userErrors: [{ field: ['x'], message: 'Testfehler' }] } } }), { status: 200 });
      await fetch(u, i); throw new Error('Zeitlimit (Test)');
    }
    return fetch(u, i);
  } });
}
const withPlatform = (ops: UndoOp[]) => ops.map(o => ({ ...o, platform: 'shopify' as const }));

test('Neues Produkt: scheitert ein Schritt nach dem Anlegen (Preis, Datei, Veröffentlichen), entfernt Rückgängig das Produkt trotzdem', async () => {
  const { createProduct } = await import('../../../../src/server/platform/shopify/products');
  const base = { name: 'Teilfehler', description: '<p>x</p>', price: 12, images: [] as string[], collectionIds: [C.wohn], tags: [] as string[], active: false };
  const cases: [string, Partial<typeof base>][] = [['productVariantsBulkUpdate', {}], ['fileUpdate', { images: ['32600000000001'] }], ['publishablePublish', { active: true }]];
  for (const [root, extra] of cases) {
    for (const mode of ['user', 'lost'] as const) {
      const before = snap(), undoOps: UndoOp[] = [];
      await assert.rejects(createProduct(faultyClient(root, mode), { ...base, ...extra }, undoOps), new RegExp(mode === 'user' ? 'Testfehler' : 'Zeitlimit'));
      assert.ok([...fake.state.products.values()].some(p => p.title === 'Teilfehler'), `${root}/${mode}: Produkt existiert`);
      assert.ok(undoOps.some(o => o.op === 'delete' && o.entity === 'product'), `${root}/${mode}: Löschschritt vermerkt`);
      await undo(withPlatform(undoOps));
      assert.deepEqual(snap(), before, `${root}/${mode}: Rückgängig exakt`);
      assert.ok(fake.state.media.has(32600000000001), 'verknüpfte Datei bleibt erhalten');
    }
  }
});

test('Produktbilder: scheitert ein Schritt nach dem Hinzufügen, löscht Rückgängig die neuen Medien und stellt die Reihenfolge wieder her', async () => {
  const { applyImages } = await import('../../../../src/server/platform/shopify/catalog');
  const pid = `gid://shopify/Product/${P.becher}`;
  const cases: [string, 'user' | 'lost'][] = [['fileUpdate', 'user'], ['fileUpdate', 'lost'], ['productUpdate', 'lost'], ['productReorderMedia', 'user']];
  for (const [root, mode] of cases) {
    const before = snap(), undoOps: UndoOp[] = [];
    await assert.rejects(applyImages(faultyClient(root, mode), { productId: pid, add: [{ image: 'https://example.com/neu.png', alt: 'Neu' }, { image: '32600000000001' }], remove: [], order: ['32600000000001'] }, undoOps));
    assert.notDeepEqual(snap(), before, `${root}/${mode}: etwas wurde geschrieben`);
    await undo(withPlatform(undoOps));
    assert.deepEqual(snap(), before, `${root}/${mode}: Rückgängig exakt`);
  }
});

test('App-Zugang (Dev Dashboard): Token per Client-Credentials-Grant, Zwischenspeicher, Erneuern bei 401 und vor Ablauf, Fehler ohne Secret', async () => {
  const { shopifyConf } = await import('../../../../src/server/platform/shopify/client');
  const { activeAuthMode, platformConfigured } = await import('@/lib/platforms');
  const vals = { storeDomain: fake.url, clientId: fake.clientId, clientSecret: fake.clientSecret };
  assert.equal(platformConfigured('shopify', vals), true); assert.equal(activeAuthMode('shopify', vals), 'app');
  assert.equal(activeAuthMode('shopify', { storeDomain: 'x', accessToken: 'shpat_x' }), 'token', 'bestehende Token-Apps bleiben beim Token');
  const c0 = shopifyConf({ shopify: vals });
  assert.equal(c0.auth, 'app'); assert.equal(c0.token, undefined);
  assert.throws(() => shopifyConf({ shopify: { storeDomain: fake.url } }), /Client-ID und Client-Secret/);
  let oauth = 0; const sent: string[] = [];
  const hdr = (i: RequestInit | undefined, k: string) => String((i?.headers as Record<string, string>)[k]);
  const f: typeof fetch = async (u, i) => {
    if (String(u).endsWith('/admin/oauth/access_token')) { oauth++; assert.match(String(i?.body), /grant_type=client_credentials/); assert.match(hdr(i, 'content-type'), /x-www-form-urlencoded/); }
    else sent.push(hdr(i, 'x-shopify-access-token'));
    return fetch(u, i);
  };
  const c = new ShopifyClient(() => c0, { fetch: f });
  assert.equal((await c.gql<J>('{ shop { name } }')).shop.name, 'Haus Holm');
  await Promise.all([c.gql('{ shop { name } }'), c.gql('{ shop { name } }')]);
  assert.equal(oauth, 1, 'Token wird zwischengespeichert'); assert.ok(sent.every(t => fake.appTokens.has(t)), 'App-Token im Kopf, nicht Client-Secret');
  fake.expireAppTokens();
  const m = await c.gql<J>(`mutation { productUpdate(product: { id: "gid://shopify/Product/${P.plaid}" }) { product { id } userErrors { message } } }`);
  assert.equal(m.productUpdate.product.id, `gid://shopify/Product/${P.plaid}`);
  assert.equal(oauth, 2, 'nach 401 einmal neu geholt und wiederholt');
  // kurze Laufzeit: vor Ablauf erneuern
  const short = await startFakeShopify({ port: 0, seed: false, clientCredentials: { expiresIn: 2 } });
  try {
    let n = 0;
    const sc = new ShopifyClient(() => ({ ...c0, origin: short.url, endpoint: `${short.url}/admin/api/2026-10/graphql.json` }), { fetch: async (u, i) => { if (String(u).includes('/oauth/')) n++; return fetch(u, i); } });
    await sc.gql('{ shop { name } }'); await new Promise(r => setTimeout(r, 1100)); await sc.gql('{ shop { name } }');
    assert.equal(n, 2, 'vor Ablauf neu geholt');
  } finally { await short.close(); }
  // falsches Secret, fremde Organisation: verständlich, ohne Secret
  const bad = new ShopifyClient(() => ({ ...c0, clientSecret: 'geheimes-falsches-secret-123' }));
  await assert.rejects(bad.gql('{ shop { name } }'), (e: Error) => /Client-ID oder Client-Secret ungültig/.test(e.message) && !e.message.includes('geheimes-falsches'));
  const other = await startFakeShopify({ port: 0, seed: false, clientCredentials: { shopPermitted: false } });
  try {
    const oc = new ShopifyClient(() => ({ ...c0, origin: other.url, endpoint: `${other.url}/admin/api/2026-10/graphql.json` }));
    await assert.rejects(oc.gql('{ shop { name } }'), /selben Shopify-Organisation/);
  } finally { await other.close(); }
  const dump = JSON.stringify(c);
  assert.ok(!dump.includes(fake.clientSecret) && ![...fake.appTokens.keys()].some(t => dump.includes(t)), 'kein Secret/Token im Objekt');
});

test('Stapel: inzwischen geänderte Produkte werden nicht überschrieben; Money-Werte exakt rückgängig', async () => {
  const { bulkStale, planBulk } = await import('../../../../src/server/platform/shopify/products');
  const { money, moneyRaw, currencyDigits } = await import('../../../../src/server/platform/shopify/data');
  assert.equal(money(49, 'EUR'), '49.00'); assert.equal(money(1.2345, 'KWD'), '1.235'); assert.equal(money(1000, 'JPY'), '1000'); assert.equal(money(904.5, 'JPY'), '905'); assert.equal(money(7.1), '7.10'); assert.equal(currencyDigits('KWD'), 3);
  assert.equal(moneyRaw('1.250'), '1.250'); assert.equal(moneyRaw(null), null);
  const p = { id: 'gid://shopify/Product/1', status: 'ACTIVE', tags: ['A'], variants: { nodes: [{ id: 'v1', price: '10.00', compareAtPrice: null }] } };
  const { plan } = planBulk(p, { price: { add: 1 }, tags: { add: ['B'] } }, 'EUR');
  // Mehrere Varianten: Anzahl steht in der Zusammenfassung (vorher immer wie eine Einzelpreisänderung)
  const multi = planBulk({ ...p, variants: { nodes: [{ id: 'v1', price: '18.00', compareAtPrice: null }, { id: 'v2', price: '18.00', compareAtPrice: '22.00' }] } }, { price: { percent: -10, round: '.90' } }, 'EUR');
  assert.deepEqual([multi.before, multi.after], [['Preis 18,00 € (2 Varianten)'], ['Preis 15,90 € (2 Varianten)']]);
  assert.deepEqual([planBulk(p, { price: { add: 1 } }, 'EUR').before, planBulk(p, { price: { add: 1 } }, 'EUR').after], [['Preis 10,00 €'], ['Preis 11,00 €']]);
  const vs = (price: string) => new Map([['v1', { id: 'v1', price, compareAtPrice: null }]]);
  assert.equal(bulkStale(plan!, p, vs('10.0')), null);
  assert.equal(bulkStale(plan!, p, vs('12.00')), 'Preis');
  assert.equal(bulkStale(plan!, { ...p, tags: ['A', 'C'] }, vs('10.00')), 'Tags');
  // echt: zwischen Vorschlag und Freigabe ändert jemand den Preis der Vase
  const v = fake.state.variants.get(51200000000001)!, orig = v.price;
  const before = snap();
  decide = () => { v.price = '55.00'; return true; };
  json(await call('propose_bulk_product_change', { title: 'x', reason: 'x', filter: { collectionId: C.wohn }, change: { price: { add: 1 } } }));
  decide = true;
  const res = lastResult();
  assert.equal(v.price, '55.00', 'neuere Änderung nicht überschrieben');
  assert.equal(res.counts?.failed, 1); assert.match(JSON.stringify(res.results), /Seit dem Vorschlag im Shop geändert \(Preis\)/);
  await undo(res.undo!);
  v.price = orig; assert.deepEqual(snap(), before);
  // Rückgängig schreibt den gelesenen Money-String unverändert zurück (keine Rundung; der Fake liefert immer 2 Stellen, Shopify je nach Währung)
  await roundtrip('propose_product_changes', { title: 't', reason: 'r', changes: [{ id: P.vase, fields: { price: 20 } }] }, () => assert.equal(fake.state.variants.get(51200000000001)!.price, '20.00'));
  const back = lastResult().undo!.find(o => o.op === 'req' && o.entity === 'variants')!.body as J;
  assert.equal(back.variables.variants[0].price, '49.00');
});

test('Steuer: Produkt-Werkzeuge sagen, ob Preise die Steuer enthalten; Rückgängig nimmt nur wortgleiche Mutationen', async () => {
  assert.equal(json(await call('get_product', { id: P.vase })).pricesIncludeTax, true);
  assert.equal(json(await call('list_products', { limit: 1 })).pricesIncludeTax, true);
  const { M } = await import('../../../../src/server/platform/shopify/ops');
  const sneaky = M.productUpdate.replace(/\}\s*$/, ' customerCreate(input: {}) { customer { id } } }');
  const r = await shopify.undo([{ op: 'req', entity: 'product', id: '1', method: 'POST', path: 'graphql', body: { query: sneaky, variables: {} }, platform: 'shopify' }]);
  assert.equal(r[0].ok, false); assert.match(String(r[0].error), /Ungültiger Rückgängig-Schritt/);
});

test('Kollektion mit mehr als 250 Produkten: Rückgängig stellt die manuelle Position auch hinter Platz 250 wieder her', async () => {
  const wohn = fake.state.collections.get(Number(C.wohn))!;
  const added = Array.from({ length: 260 }, (_, i) => fake.state.addProduct({ title: `Lang ${i}`, tags: ['Lang'], variants: [{ price: '5', sku: `L-${i}` }] }).id);
  const start = wohn.productIds.length;
  wohn.productIds.push(...added);
  const target = String(added[255]);
  await roundtrip('propose_collection_products', { title: 'P', reason: 'P', collectionId: C.wohn, remove: [target] }, () => {
    assert.ok(!fake.state.collections.get(Number(C.wohn))!.productIds.includes(Number(target)));
  });
  assert.equal(wohn.productIds.indexOf(Number(target)), start + 255, 'wieder an alter Position');
  wohn.productIds = wohn.productIds.filter(id => !added.includes(id));
  for (const id of added) fake.state.products.delete(id);
});

// ---- Verlorene Antworten, Varianten mit updateAll, Sommerzeit, 5xx, Bereiche, Stapel-Grenzen, gebündelte Abfragen ----
const rq: Q = (d, v) => (session.reader as InstanceType<typeof ShopifyReader>).query(d, v);
const allOf = (cs: { items: { id: string }[] }) => new Set(cs.items.map(i => i.id));

test('Name inzwischen geändert: die Zeile wird nicht geschrieben, der Hersteller derselben Entität schon', async () => {
  const { applyProducts, buildProductChangeSet } = await import('../../../../src/server/platform/shopify/products');
  const { applyCollections, buildCollectionChangeSet } = await import('../../../../src/server/platform/shopify/catalog');
  const product = fake.state.products.get(Number(P.vase))!;
  const before = snap();
  const cs = await buildProductChangeSet(rq, { title: 't', reason: 'r', changes: [{ id: P.vase, fields: { name: 'Vase neu', vendor: 'Andere' } }] }, 'EUR');
  product.title = 'Vase fremd';
  const r = await applyProducts(new ShopifyClient(conf), cs, allOf(cs));
  const name = r.results.find(x => x.itemId.endsWith(':name'))!, vendor = r.results.find(x => x.itemId.endsWith(':vendor'))!;
  assert.equal(name.ok, false, JSON.stringify(r.results));
  assert.match(name.error ?? '', /inzwischen geändert/);
  assert.equal(vendor.ok, true, JSON.stringify(r.results));
  assert.equal(product.title, 'Vase fremd');
  assert.equal(product.vendor, 'Andere');
  await undo(withPlatform(r.undo));
  product.title = 'Vase „Kiesel“';
  assert.deepEqual(snap(), before);

  const col = fake.state.collections.get(Number(C.wohn))!;
  const beforeC = snap();
  const ccs = await buildCollectionChangeSet(rq, { title: 't', reason: 'r', changes: [{ id: C.wohn, fields: { name: 'Wohnen neu', metaTitle: 'Neu' } }] });
  col.title = 'Fremd';
  const cr = await applyCollections(new ShopifyClient(conf), ccs, allOf(ccs));
  const cname = cr.results.find(x => x.itemId.endsWith(':name'))!, meta = cr.results.find(x => x.itemId.endsWith(':metaTitle'))!;
  assert.equal(cname.ok, false, JSON.stringify(cr.results));
  assert.match(cname.error ?? '', /inzwischen geändert/);
  assert.equal(meta.ok, true, JSON.stringify(cr.results));
  assert.equal(col.title, 'Fremd');
  assert.equal(col.seo.title, 'Neu');
  await undo(withPlatform(cr.undo));
  col.title = 'Wohnaccessoires';
  assert.deepEqual(snap(), beforeC);
});
/** Anfragen im Fake-Protokoll, deren Query den Text enthält (seit Index from) */
const requestsLike = (from: number, re: RegExp) => fake.state.requestLog.slice(from).filter(r => re.test(r.query)).length;

test('Verlorene Antwort nach dem Senden: jede Schreibung vermerkt ihr Rückgängig, die Zeile meldet den Fehler, Rückgängig ist exakt', async () => {
  const { applyProducts, buildProductChangeSet, applyBulk, bulkChangeSet, scanProducts, applyVariants, buildVariantsChangeSet } = await import('../../../../src/server/platform/shopify/products');
  const { applyCollections, buildCollectionChangeSet, applyNewCollections, buildNewCollectionsChangeSet, applyCollectionProducts, buildCollectionProductsChangeSet, applyAltTexts, buildAltTextChangeSet, applyHandles, buildHandlesChangeSet } = await import('../../../../src/server/platform/shopify/catalog');
  const { applyTranslations, buildTranslationChangeSet, applyPromotion, buildPromotionChangeSet, applyPromotionStatus, buildPromotionStatusChangeSet } = await import('../../../../src/server/platform/shopify/content');
  const sommer = String([...fake.state.discounts.values()].find(d => d.title === 'Sommer')!.id), shop = { currency: 'EUR', timezone: 'Europe/Berlin' };
  type Out = { results: { ok: boolean }[]; undo: UndoOp[] };
  const cases: [string, string, (c: InstanceType<typeof ShopifyClient>) => Promise<Out>][] = [
    ['productUpdate', 'Produktfelder', async c => { const cs = await buildProductChangeSet(rq, { title: 't', reason: 'r', changes: [{ id: P.vase, fields: { name: 'Vase verloren', tags: { add: ['Verloren'] } } }] }, 'EUR'); return applyProducts(c, cs, allOf(cs)); }],
    ['productVariantsBulkUpdate', 'Produktpreise', async c => { const cs = await buildProductChangeSet(rq, { title: 't', reason: 'r', changes: [{ id: P.vase, fields: { price: { add: 1 } } }] }, 'EUR'); return applyProducts(c, cs, allOf(cs)); }],
    ['metafieldsSet', 'FAQ', async c => { const cs = await buildProductChangeSet(rq, { title: 't', reason: 'r', changes: [{ id: P.plaid, fields: { faq: { items: [{ q: 'A?', a: 'B.' }, { q: 'C?', a: 'D.' }] } } }] }, 'EUR'); return applyProducts(c, cs, allOf(cs)); }],
    ['productUpdate', 'Stapel (Tags)', async c => { const { cs, payload } = bulkChangeSet('t', 'r', { tags: { add: ['Verloren'] } }, await scanProducts(rq, { collectionId: C.wohn }), 'EUR'); return applyBulk(c, cs, payload, allOf(cs)); }],
    ['productVariantsBulkUpdate', 'Stapel (Preise)', async c => { const { cs, payload } = bulkChangeSet('t', 'r', { price: { add: 1 } }, await scanProducts(rq, { collectionId: C.wohn }), 'EUR'); return applyBulk(c, cs, payload, allOf(cs)); }],
    ['productVariantsBulkCreate', 'Neue Variante', async c => { const cs = await buildVariantsChangeSet(rq, { title: 't', reason: 'r', productId: P.becher, create: [{ options: { Farbe: 'Salbei', Größe: '350 ml' }, price: 11 }] }, 'EUR'); return applyVariants(c, cs, allOf(cs)); }],
    ['collectionUpdate', 'Kollektionstexte', async c => { const cs = await buildCollectionChangeSet(rq, { title: 't', reason: 'r', changes: [{ id: C.wohn, fields: { metaTitle: 'Verloren' } }] }); return applyCollections(c, cs, allOf(cs)); }],
    ['publishableUnpublish', 'Kollektion ausblenden', async c => { const cs = await buildCollectionChangeSet(rq, { title: 't', reason: 'r', changes: [{ id: C.wohn, fields: { active: false } }] }); return applyCollections(c, cs, allOf(cs)); }],
    ['collectionCreate', 'Neue Kollektion', async c => { const cs = await buildNewCollectionsChangeSet(rq, { title: 't', reason: 'r', collections: [{ name: 'Verloren', productIds: [P.vase] }] }, async () => null); return applyNewCollections(c, cs, allOf(cs)); }],
    ['collectionUpdate', 'Regel ändern', async c => { const cs = await buildNewCollectionsChangeSet(rq, { title: 't', reason: 'r', collections: [{ id: C.keramik, sortOrder: 'PRICE_DESC' }] }, async () => null); return applyNewCollections(c, cs, allOf(cs)); }],
    ['collectionRemoveProducts', 'Produkt aus Kollektion', async c => { const cs = await buildCollectionProductsChangeSet(rq, { title: 't', reason: 'r', collectionId: C.wohn, remove: [P.vase] }); return applyCollectionProducts(c, cs, allOf(cs)); }],
    ['fileUpdate', 'Alt-Text', async c => { const cs = await buildAltTextChangeSet(rq, { title: 't', reason: 'r', images: [{ mediaId: '32600000000001', alt: 'Verloren' }] }, null); return applyAltTexts(c, cs, allOf(cs)); }],
    ['productUpdate', 'Handle', async c => { const cs = await buildHandlesChangeSet(rq, { title: 't', reason: 'r', changes: [{ entity: 'product', id: P.vase, slug: 'vase-verloren' }] }); return applyHandles(c, cs, allOf(cs)); }],
    ['translationsRegister', 'Übersetzung', async c => { const cs = await buildTranslationChangeSet(rq, { title: 't', reason: 'r', entity: 'product', changes: [{ id: P.becher, language: 'en', fields: { name: 'Lost mug', metaTitle: 'Lost' } }] }); return applyTranslations(c, cs, allOf(cs)); }],
    ['discountCodeBasicUpdate', 'Rabatt ändern', async c => { const { cs, payload } = await buildPromotionChangeSet(rq, { id: sommer, reason: 'r', usageLimit: 7 }, shop); return applyPromotion(c, cs, payload as { id?: string; input: J }, allOf(cs)); }],
    ['discountCodeBasicCreate', 'Rabatt anlegen', async c => { const { cs, payload } = await buildPromotionChangeSet(rq, { reason: 'r', title: 'Verloren', code: 'LOST1', type: 'percentage', value: 5 }, shop); return applyPromotion(c, cs, payload as { id?: string; input: J }, allOf(cs)); }],
    ['discountCodeDeactivate', 'Rabatt beenden', async c => { const cs = await buildPromotionStatusChangeSet(rq, { ids: [sommer], action: 'deactivate' }, shop); return applyPromotionStatus(c, cs, allOf(cs)); }],
  ];
  for (const [root, label, run] of cases) {
    const before = snap();
    const r = await run(faultyClient(root, 'lost'));
    assert.ok(r.results.length && r.results.every(x => !x.ok), `${label}: Zeile meldet den Fehler (${JSON.stringify(r.results)})`);
    assert.notDeepEqual(snap(), before, `${label}: die Mutation hat trotz verlorener Antwort gewirkt`);
    assert.ok(r.undo.length, `${label}: Rückgängig vermerkt`);
    await undo(withPlatform(r.undo));
    assert.deepEqual(snap(), before, `${label}: Rückgängig exakt`);
  }
  // Anlegen mit verlorener Antwort: Produkt per Titel nachgelesen und zum Löschen vorgemerkt
  const { createProduct } = await import('../../../../src/server/platform/shopify/products');
  const before = snap(), ops: UndoOp[] = [];
  await assert.rejects(createProduct(faultyClient('productCreate', 'lost'), { name: 'Verlorene Kanne', description: '<p>x</p>', price: 5, images: [], collectionIds: [], tags: [], active: false }, ops), /Zeitlimit/);
  assert.ok([...fake.state.products.values()].some(p => p.title === 'Verlorene Kanne'));
  assert.ok(ops.some(o => o.op === 'delete' && o.entity === 'product'), 'Löschschritt vermerkt');
  await undo(withPlatform(ops));
  assert.deepEqual(snap(), before);
  // bei userErrors hat Shopify nichts geändert: kein Rückgängig-Schritt
  const r = await (async () => { const cs = await buildCollectionChangeSet(rq, { title: 't', reason: 'r', changes: [{ id: C.wohn, fields: { metaTitle: 'Nie' } }] }); return applyCollections(faultyClient('collectionUpdate', 'user'), cs, allOf(cs)); })();
  assert.equal(r.undo.length, 0); assert.deepEqual(snap(), before);
});

test('Zwischenstand (B1): Executor ohne applyEach melden Rückgängig-Schritte, bevor das Ergebnis steht (Rabatt anlegen, Kollektion, Varianten)', async () => {
  const { applyCollections, buildCollectionChangeSet } = await import('../../../../src/server/platform/shopify/catalog');
  const { applyPromotion, buildPromotionChangeSet } = await import('../../../../src/server/platform/shopify/content');
  const { applyVariants, buildVariantsChangeSet } = await import('../../../../src/server/platform/shopify/products');
  const shop = { currency: 'EUR', timezone: 'Europe/Berlin' }, before = snap();
  const ticks: { done: number; total: number; undo: number }[] = [], ctx = { progress: (done: number, total: number, p?: { undo: UndoOp[] }) => ticks.push({ done, total, undo: p?.undo.length ?? -1 }) };
  // Rabatt anlegen mit verlorener Antwort: der Löschschritt steht schon im Zwischenstand, obwohl die Zeile am Ende „fehlgeschlagen“ meldet
  const { cs: pcs, payload } = await buildPromotionChangeSet(rq, { reason: 'r', title: 'Zwischen', code: 'ZWISCH1', type: 'percentage', value: 5 }, shop);
  const pr = await applyPromotion(faultyClient('discountCodeBasicCreate', 'lost'), pcs, payload as { id?: string; input: J }, allOf(pcs), ctx);
  assert.ok(pr.results.every(x => !x.ok) && pr.undo.length);
  assert.ok(ticks.length && ticks.every(t => t.done === 0 && t.total === pcs.items.length) && ticks.at(-1)!.undo === pr.undo.length, JSON.stringify(ticks));
  await undo(withPlatform(pr.undo)); assert.deepEqual(snap(), before);
  ticks.length = 0;
  const ccs = await buildCollectionChangeSet(rq, { title: 't', reason: 'r', changes: [{ id: C.wohn, fields: { metaTitle: 'Zwischen', active: false } }] });
  const cr = await applyCollections(new ShopifyClient(conf), ccs, allOf(ccs), ctx);
  assert.ok(cr.results.every(x => x.ok));
  assert.deepEqual(ticks.at(-1), { done: 2, total: 2, undo: cr.undo.length }, 'ein Tick je Kollektion mit allen Zeilen');
  await undo(withPlatform(cr.undo)); assert.deepEqual(snap(), before);
  ticks.length = 0;
  const vcs = await buildVariantsChangeSet(rq, { title: 't', reason: 'r', productId: P.becher, create: [{ options: { Farbe: 'Salbei', Größe: '350 ml' }, price: 11 }] }, 'EUR');
  const vr = await applyVariants(new ShopifyClient(conf), vcs, allOf(vcs), ctx);
  assert.ok(vr.results.every(x => x.ok) && vr.undo.length);
  assert.ok(ticks.some(t => t.undo === vr.undo.length), 'Löschschritt der neuen Variante gemeldet');
  await undo(withPlatform(vr.undo)); assert.deepEqual(snap(), before);
});

test('Varianten: updateAll gilt für alle Varianten, update derselben Variante ergänzt feldweise (SKU + Preisregel): rückgängig', async () => {
  await roundtrip('propose_variants', { title: 'V', reason: 'V', productId: P.becher, update: [{ id: '51200000000005', sku: 'HH-B-N' }, { id: '51200000000001', sku: 'FREMD' }], updateAll: { price: { percent: -10 } } }, () => {
    const b = [...fake.state.variants.values()].filter(v => String(v.productId) === P.becher);
    assert.deepEqual(b.map(v => v.price), ['16.20', '16.20', '16.20', '16.20'], 'Preisregel wirkt auch auf die Variante mit eigener SKU-Änderung');
    assert.equal(fake.state.variants.get(51200000000005)!.sku, 'HH-B-N');
  });
  const cs = lastSet();
  assert.equal(cs.items.filter(i => i.field === 'price').length, 4); assert.equal(cs.items.filter(i => i.field === 'sku').length, 1);
  assert.ok(cs.skipped.some(s => s.id === '51200000000001' && /gehört nicht/.test(s.reason)), 'fremde Variante bleibt übersprungen');
  // update hat feldweise Vorrang vor updateAll
  decide = false;
  json(await call('propose_variants', { title: 'V', reason: 'V', productId: P.becher, update: [{ id: '51200000000005', price: 30 }], updateAll: { price: { percent: -10 } } }));
  decide = true;
  assert.equal(lastSet().items.find(i => i.id === '51200000000005:price')?.after, '30,00 €');
});

test('Rabatte: Tagesdaten gelten in der Shop-Zeitzone (Sommerzeit), Karte zeigt den eingegebenen Tag; aktivieren stellt beim Rückgängig das Enddatum wieder her', async () => {
  const { toIso } = await import('../../../../src/server/platform/shopify/content');
  const berlin = (iso: string) => new Date(iso).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
  assert.equal(berlin(toIso('2026-07-31', true)), '31.7.2026, 23:59:59'); assert.equal(berlin(toIso('2026-07-01')), '1.7.2026, 00:00:00');
  assert.equal(berlin(toIso('2026-12-31', true)), '31.12.2026, 23:59:59');
  assert.equal(new Date(toIso('2026-07-31', true, 'America/New_York')).toLocaleString('de-DE', { timeZone: 'America/New_York' }), '31.7.2026, 23:59:59');
  assert.equal(toIso('2026-07-01T10:00:00Z'), '2026-07-01T10:00:00.000Z'); assert.throws(() => toIso('2026-02-30'), /ungültig/);
  await roundtrip('propose_promotion', { reason: 'Sommer', title: 'Sommer 5 %', code: 'JULI5', type: 'percentage', value: 5, startsAt: '2026-07-01', endsAt: '2026-07-31' }, () => {
    const d = [...fake.state.discounts.values()].find(x => x.title === 'Sommer 5 %')!;
    assert.equal(berlin(d.startsAt), '1.7.2026, 00:00:00'); assert.equal(berlin(d.endsAt!), '31.7.2026, 23:59:59');
  });
  assert.match(lastSet().items[0].after, /1\.7\.2026 bis 31\.7\.2026/);
  // abgelaufener Rabatt wieder aktivieren: Enddatum entfällt, Rückgängig stellt es wieder her
  json(await call('propose_promotion', { reason: 'x', title: 'Winter', code: 'WINTER5', type: 'percentage', value: 5, startsAt: '2026-01-01', endsAt: '2026-02-01' }));
  const id = String([...fake.state.discounts.values()].find(d => d.title === 'Winter')!.id);
  assert.equal(json(await call('get_promotion', { id })).status, 'abgelaufen');
  await roundtrip('propose_promotion_status', { ids: [id], action: 'activate' }, async () => {
    const d = fake.state.discounts.get(Number(id))!; assert.equal(d.endsAt, null); assert.equal(json(await call('get_promotion', { id })).status, 'läuft');
  });
  assert.equal(berlin(fake.state.discounts.get(Number(id))!.endsAt!), '1.2.2026, 23:59:59');
});

test('Client: 5xx wird nur beim Lesen wiederholt; eine Mutation geht genau einmal raus und schreibt nicht doppelt', async () => {
  let sent = 0;
  const c = new ShopifyClient(conf, { sleep: async () => {}, fetch: async (u, i) => { sent++; return fetch(u, i); } });
  fake.failNext({ status: 503 });
  assert.equal((await c.gql<J>('{ shop { name } }')).shop.name, 'Haus Holm'); assert.equal(sent, 2, 'Lesen: ein Fehlversuch, dann wiederholt');
  const title = fake.state.products.get(Number(P.plaid))!.title, n0 = fake.state.requestLog.length;
  sent = 0; fake.failNext({ status: 502 });
  await assert.rejects(c.gql(`mutation { productUpdate(product: { id: "gid://shopify/Product/${P.plaid}", title: "Doppelt" }) { product { id } userErrors { message } } }`), /HTTP 502/);
  assert.equal(sent, 1, 'Mutation nicht wiederholt'); assert.equal(fake.state.products.get(Number(P.plaid))!.title, title);
  assert.equal(requestsLike(n0, /productUpdate/), 0, 'die abgewiesene Mutation wurde nie ausgeführt');
  assert.equal((await c.gql<J>('{ shop { name } }')).shop.name, 'Haus Holm', 'Fehlerwarteschlange ist verbraucht');
});

test('Reader-Bereiche: Kategorien sperren Kollektionen auch verschachtelt, Marketing sperrt Rabatte; Produkte bleiben lesbar', async () => {
  const reader = session.reader as InstanceType<typeof ShopifyReader>;
  updateSettings({ scopes: { categories: false } });
  try {
    await assert.rejects(reader.query('{ collections(first: 1) { nodes { id } } }'), /Kategorien/);
    const p = await call('get_product', { id: P.vase }); assert.equal(p.isError, true); assert.match(p.content[0].text, /Kategorien/);
    const c = await call('search_categories', {}); assert.equal(c.isError, true);
    assert.equal(json(await call('search_products', { term: 'Vase' })).total, 1);
  } finally { updateSettings({ scopes: { categories: true } }); }
  updateSettings({ scopes: { marketing: false } });
  try {
    const l = await call('list_promotions', {}); assert.equal(l.isError, true); assert.match(l.content[0].text, /Marketing/);
    const g = await call('get_promotion', { id: '1' }); assert.equal(g.isError, true); assert.match(g.content[0].text, /Marketing/);
    assert.equal(json(await call('search_categories', {})).length, 2);
  } finally { updateSettings({ scopes: { marketing: true } }); }
});

test('Stapel: nur die Gruppe „ohne Auffälligkeiten“ freigeben lässt die Warn-Gruppe unangetastet; Obergrenze bricht vor dem Änderungsset ab', async () => {
  const { scanProducts } = await import('../../../../src/server/platform/shopify/products');
  await assert.rejects(scanProducts(rq, { tag: 'Serie' }, 5), /Mehr als 5 Produkte/);
  decide = cs => { assert.deepEqual(cs.items.map(i => i.id), ['grp:ok', 'grp:warn']); return ['grp:ok']; };
  const before = snap(), vase = fake.state.variants.get(51200000000001)!.compareAtPrice, plaid = fake.state.variants.get(51200000000006)!.compareAtPrice;
  // Streichpreis 30: Becher (18 €) ohne Auffälligkeit, Vase (49 €) und Plaid (89 €) mit Warnung „Streichpreis ≤ Preis“
  const out = json(await call('propose_bulk_product_change', { title: 'x', reason: 'x', filter: { collectionId: C.wohn }, change: { listPrice: { set: 30 } } }));
  decide = true;
  assert.equal(out.status, 'applied'); assert.equal(lastResult().counts?.applied, 1);
  assert.equal(fake.state.variants.get(51200000000002)!.compareAtPrice, '30.00');
  assert.equal(fake.state.variants.get(51200000000001)!.compareAtPrice, vase, 'Warn-Gruppe unangetastet'); assert.equal(fake.state.variants.get(51200000000006)!.compareAtPrice, plaid);
  await undo(lastResult().undo!);
  assert.deepEqual(snap(), before);
});

test('Rückgängig: Anlege-Mutationen sind keine erlaubten Rückgängig-Schritte', async () => {
  const { M } = await import('../../../../src/server/platform/shopify/ops');
  for (const q of [M.productCreate, M.collectionCreate, M.discountCreate, M.variantsCreate, M.pageCreate, M.fileCreate]) {
    const r = await shopify.undo([{ op: 'req', entity: 'x', id: '1', method: 'POST', path: 'graphql', body: { query: q, variables: {} }, platform: 'shopify' }]);
    assert.equal(r[0].ok, false); assert.match(String(r[0].error), /Ungültiger Rückgängig-Schritt/);
  }
});

test('Gebündelte Abfragen: Rabatte per nodes, Weiterleitungen und Handle-Prüfung je Abfrage statt je Zeile; Stapel-Scan mit 50 je Seite', async () => {
  const { discountsByIds } = await import('../../../../src/server/platform/shopify/content');
  const { scanProducts, BULK_PAGE } = await import('../../../../src/server/platform/shopify/products');
  const ids = [...fake.state.discounts.values()].map(d => String(d.id)); assert.ok(ids.length >= 2);
  let n = fake.state.requestLog.length;
  const rows = await discountsByIds(rq, [...ids, '1']);
  assert.equal(rows.length, ids.length); assert.equal(fake.state.requestLog.length - n, 1, 'eine Abfrage für alle Rabatte');
  n = fake.state.requestLog.length;
  const seo = json(await call('get_seo_urls', { productIds: [P.vase, P.becher], categoryIds: [C.wohn], pageIds: ['129000000001'] }));
  assert.equal(seo.length, 4); assert.equal(requestsLike(n, /Redirects/), 1, 'eine Abfrage für alle Weiterleitungen');
  n = fake.state.requestLog.length; decide = false;
  json(await call('propose_seo_urls', { title: 'U', reason: 'U', changes: [{ entity: 'product', id: P.vase, slug: 'a-1' }, { entity: 'product', id: P.becher, slug: 'vase-kiesel' }, { entity: 'product', id: P.plaid, slug: 'a-3' }, { entity: 'category', id: C.wohn, slug: 'keramik' }] }));
  decide = true;
  assert.equal(requestsLike(n, /Taken/), 2, 'je Art eine Abfrage');
  assert.deepEqual(lastSet().skipped.map(s => s.reason).sort(), ['/collections/keramik ist schon vergeben', '/products/vase-kiesel ist schon vergeben']);
  n = fake.state.requestLog.length;
  assert.equal((await scanProducts(rq, { tag: 'Serie' })).length, 140);
  assert.equal(requestsLike(n, /SearchProducts/), Math.ceil(140 / BULK_PAGE), 'Seiten zu je BULK_PAGE Produkten');
});

test('Karte: Bildänderungen zeigen Dateinamen statt Markup, Alt-Texte ohne leeren Vergleich', async () => {
  decide = false;
  json(await call('propose_product_images', { title: 'B', reason: 'B', products: [{ productId: P.becher, cover: '32600000000003' }] }));
  const im = lastSet().items[0];
  assert.doesNotMatch(String(im.html?.after), /<img/); assert.equal(im.html?.before, '1. becher-morgen-sand.jpg\n2. becher-morgen-nachtblau.jpg'); assert.match(String(im.html?.after), /^1\. becher-morgen-nachtblau\.jpg/);
  json(await call('propose_alt_texts', { title: 'A', reason: 'A', images: [{ mediaId: '32600000000001', alt: 'Vase aus hellem Steinzeug auf Holz' }] }));
  decide = true;
  assert.equal(lastSet().items[0].html, undefined); assert.equal(lastSet().items[0].after, 'Vase aus hellem Steinzeug auf Holz');
});

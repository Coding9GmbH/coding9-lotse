// Shopify supplier import: planning (pure) and applying against the Admin GraphQL fake; undo restores the state exactly.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatEvent } from '@/lib/protocol';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-shopify-import-'));
delete process.env.SHOP_PLATFORM;

const { startFakeShopify } = await import('../../../support/shopify-fake/server');
const fake = await startFakeShopify({ port: 0 });
after(() => fake.close());
const { updateSettings } = await import('../../../../src/server/settings');
const { getSession, decideChange } = await import('../../../../src/server/sessions');
const { buildTools, toolNamesFor } = await import('../../../../src/server/tools');
const { getPlatform, reconfigureAll } = await import('../../../../src/server/platform/index');
const { saveFile } = await import('../../../../src/server/files');
const { parseTable } = await import('../../../../src/server/features/import-parse');
const { planShopifyImport, shopifyPrice, resolveCollections } = await import('../../../../src/server/platform/shopify/import');

updateSettings({ platform: 'shopify', shopify: { storeDomain: fake.url, accessToken: fake.token, apiVersion: '2026-10' } });
reconfigureAll();
const shopify = getPlatform('shopify');
type Res = { isError?: boolean; content: { text: string }[] };
const session = getSession('chat-shopify-import');
const events: ChatEvent[] = [];
session.emit = ev => { events.push(ev); session.events.push(ev); if (ev.t === 'changeset') setTimeout(() => decideChange(session.id, ev.approvalId, true), 0); };
const tools = buildTools(session);
const call = async (name: string, args: Record<string, unknown>) => (await tools.find(x => x.name === name)!.handler(args, {})) as Res;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (r: Res): any => { assert.equal(r.isError ?? false, false, r.content[0].text); return JSON.parse(r.content[0].text); };
const lastResult = () => [...events].reverse().find((e): e is Extract<ChatEvent, { t: 'changeset_result' }> => e.t === 'changeset_result')!;
function snap() {
  const s = JSON.parse(JSON.stringify(fake.state.snapshot()));
  const strip = (x: unknown): unknown => Array.isArray(x) ? x.map(strip) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).filter(([k]) => !['updatedAt', 'createdInRequest'].includes(k)).map(([k, v]) => [k, strip(v)])) : x;
  delete s.requestCount; delete s.stagedUploads; delete s.bulkOperations; delete s.themes;
  return strip(s);
}

const CSV = [
  'Artikelnummer;EAN;Bezeichnung;Beschreibung;VK brutto;UVP;Hersteller;Kategorie;Bild;Hauptartikel;Farbe;Bestand',
  'HH-VASE-KIESEL;4260123450011;Vase „Kiesel“;;52,00;;Haus Holm;Wohnaccessoires;;;;7',
  'HH-SCHALE-1;4260123459999;Schale „Ebbe“;Flache Schale aus Steinzeug.;29,00;34,00;Töpferei Nord;Wohnaccessoires;https://cdn.example.com/schale.jpg;;;3',
  'HH-KISSEN;;Kissen „Watt“;Leinen.;25,00;;;Gibt es nicht;;;;',
  'HH-DECKE;;Decke „Sog“;Wolle.;;;;;;;;',
  'TUCH-S;;Tuch „Priel“ Sand;Baumwolle.;19,00;;;;;TUCH;Sand;',
  'TUCH-B;;Tuch „Priel“ Blau;Baumwolle.;19,00;;;;;TUCH;Blau;',
].join('\n');
const MAPPING = { productNumber: 'Artikelnummer', ean: 'EAN', name: 'Bezeichnung', description: 'Beschreibung', priceGross: 'VK brutto', listPrice: 'UVP', manufacturer: 'Hersteller', category: 'Kategorie', images: ['Bild'], parentNumber: 'Hauptartikel', variantOptions: [{ group: 'Farbe', column: 'Farbe' }], stock: 'Bestand' };

test('prices: gross/net depending on shop setting, never estimated; collections by title/handle, smart ones rejected', () => {
  assert.deepEqual(shopifyPrice({ gross: 11.9 }, true), { price: 11.9 });
  assert.equal(shopifyPrice({ net: 10, taxRate: 19 }, true).price, 11.9);
  assert.equal(shopifyPrice({ gross: 11.9, taxRate: 19 }, false).price, 10);
  assert.deepEqual(shopifyPrice({}, true), {});
  const cat = { bySku: new Map(), byBarcode: new Map(), taxesIncluded: true, currency: 'EUR', notes: [], collections: [{ id: '1', title: 'Wohnaccessoires', handle: 'wohnaccessoires', manual: true }, { id: '2', title: 'Keramik', handle: 'keramik', manual: false }] };
  assert.deepEqual(resolveCollections('Wohnen > Wohnaccessoires|Keramik|Gibt es nicht', cat), { ids: ['1'], missing: ['Gibt es nicht'], smart: ['Keramik'] });
  assert.deepEqual(resolveCollections('Gibt es nicht', cat, { 'Gibt es nicht': '1' }).ids, ['1']);
});

test('planning (pure): update only changed fields, new products as drafts, variant family, notes on columns not taken over', async () => {
  const t = await parseTable(Buffer.from(CSV), 'lieferant.csv');
  const v = { variantId: 'gid://shopify/ProductVariant/1', productId: 'gid://shopify/Product/9100000000001', sku: 'HH-VASE-KIESEL', barcode: '4260123450011', price: '49.00', compareAtPrice: null, product: { title: 'Vase „Kiesel“', descriptionHtml: '<p>x</p>', vendor: 'Haus Holm', tags: [], seo: { title: null, description: null }, collections: ['480000000001'], media: 1, variants: 1 } };
  const cat = { bySku: new Map([['HH-VASE-KIESEL', v]]), byBarcode: new Map(), taxesIncluded: true, currency: 'EUR', notes: [], collections: [{ id: '480000000001', title: 'Wohnaccessoires', handle: 'wohnaccessoires', manual: true }] };
  const r = planShopifyImport(t, MAPPING, cat, {}, { title: 'Import', reason: 'Test', fileName: 'lieferant.csv' });
  assert.equal(r.stats.unchanged, 1, 'vase: price not changed without updatePrices, otherwise equal');
  assert.equal(r.stats.create, 3, 'bowl, cushion, cloth family'); assert.equal(r.stats.variantRows, 2);
  assert.ok(r.cs.skipped.some(s => /HH-DECKE.*Preis fehlt/.test(s.reason)));
  assert.deepEqual(r.stats.unknownCategories, ['Gibt es nicht']);
  assert.match(r.stats.ignored.join(), /Bestand/);
  const fam = r.payload.plans.find(p => p.kind === 'create' && p.options);
  assert.ok(fam && fam.kind === 'create'); assert.equal(fam.product.name, 'Tuch „Priel“'); assert.deepEqual(fam.options, [{ name: 'Farbe', values: ['Sand', 'Blau'] }]);
  const withPrices = planShopifyImport(t, MAPPING, cat, { updatePrices: true, mode: 'update' }, { title: 'Import', reason: 'Test', fileName: 'x' });
  const up = withPrices.payload.plans[0]; assert.equal(up.kind, 'update'); assert.equal(up.kind === 'update' && up.variants[0].price, 52);
  assert.match(withPrices.cs.items[0].after, /52,00 €/);
});

test('apply against the fake: price update, new product with collection, variant family; exact undo', async () => {
  assert.ok(toolNamesFor('shopify').includes('propose_import'));
  const f = saveFile(Buffer.from(CSV), 'lieferant.csv');
  const read = json(await call('read_supplier_file', { fileId: f.fileId }));
  assert.equal(read.rowCount, 6);
  const prev = json(await call('preview_import', { fileId: f.fileId, mapping: MAPPING, options: { updatePrices: true } }));
  assert.deepEqual(prev.stats.unknownCategories, ['Gibt es nicht']);
  const before = snap();
  const out = json(await call('propose_import', { fileId: f.fileId, title: 'Lieferant Nord', reason: 'Neue Preise und Artikel', mapping: MAPPING, options: { updatePrices: true } }));
  assert.equal(out.status, 'applied', JSON.stringify(out));
  assert.equal(out.created.length, 3); assert.equal(out.updated.length, 1);
  const vase = fake.state.findProductByHandle('vase-kiesel')!;
  assert.equal(fake.state.productVariants(vase)[0].price, '52.00');
  const schale = [...fake.state.products.values()].find(p => p.title === 'Schale „Ebbe“')!;
  assert.equal(schale.status, 'DRAFT'); assert.equal(schale.vendor, 'Töpferei Nord');
  assert.equal(fake.state.productVariants(schale)[0].compareAtPrice, '34.00');
  assert.ok(fake.state.collections.get(480000000001)!.productIds.includes(schale.id), 'added to manual collection');
  const tuch = [...fake.state.products.values()].find(p => p.title === 'Tuch „Priel“')!;
  assert.deepEqual(fake.state.productVariants(tuch).map(v => v.sku).sort(), ['TUCH-B', 'TUCH-S']);
  const res = lastResult(); assert.ok(res.undo?.length);
  const r = await shopify.undo(res.undo!); assert.ok(r.every(x => x.ok), JSON.stringify(r));
  assert.deepEqual(snap(), before, 'import reverted exactly');
});

// ---- existing products with multiple variants ----
const shirt = (sku: string, id: number) => ({ variantId: `gid://shopify/ProductVariant/${id}`, productId: 'gid://shopify/Product/1', sku, barcode: null, price: '20.00', compareAtPrice: null, product: { title: 'Shirt', descriptionHtml: '<p>Baumwolle.</p>', vendor: 'Nord', tags: [], seo: { title: null, description: null }, collections: [], media: 1, variants: 2 } });
const shirtCat = () => ({ bySku: new Map([['S-R', shirt('S-R', 11)], ['S-B', shirt('S-B', 12)]]), byBarcode: new Map(), taxesIncluded: true, currency: 'EUR', notes: [], collections: [] });
const HEAD = 'Artikelnummer;EAN;Bezeichnung;Beschreibung;VK brutto;UVP;Hersteller;Kategorie;Bild;Hauptartikel;Farbe;Bestand';
const meta = { title: 'Import', reason: 'Test', fileName: 'x.csv' };
const FLAT = { productNumber: 'Artikelnummer', ean: 'EAN', name: 'Bezeichnung', description: 'Beschreibung', priceGross: 'VK brutto' };

test('variants of existing products, without parent product column: one update per product, prices per variant, differing titles not taken over', async () => {
  const t = await parseTable(Buffer.from([HEAD, 'S-R;;Shirt Rot;Baumwolle.;21,00;;;;;;Rot;', 'S-B;;Shirt Blau;Baumwolle.;22,00;;;;;;Blau;'].join('\n')), 'x.csv');
  const r = planShopifyImport(t, FLAT, shirtCat(), { updatePrices: true, mode: 'update' }, meta);
  assert.equal(r.payload.plans.length, 1, 'exactly one plan per product (no parallel writes)');
  const p = r.payload.plans[0]; assert.ok(p.kind === 'update');
  assert.equal(p.product.title, undefined, 'variant names do not overwrite the product title');
  assert.deepEqual(p.variants, [{ id: 'gid://shopify/ProductVariant/11', price: 21 }, { id: 'gid://shopify/ProductVariant/12', price: 22 }]);
  assert.ok(r.cs.items[0].warn.some(w => /Titel je Zeile verschieden/.test(w)), JSON.stringify(r.cs.items[0].warn));
  // a single variant row: do not take over the title (it carries the variant name)
  const one = planShopifyImport(await parseTable(Buffer.from([HEAD, 'S-R;;Shirt Rot;;21,00;;;;;;;'].join('\n')), 'x.csv'), FLAT, shirtCat(), { updatePrices: true }, meta);
  const q = one.payload.plans[0]; assert.ok(q.kind === 'update'); assert.equal(q.product.title, undefined); assert.equal(q.variants.length, 1);
  assert.ok(one.cs.items[0].warn.some(w => /Titel nicht übernommen/.test(w)));
});

test('variants of existing products, with parent product column: update matching variants, product fields from the parent row, new variants skipped', async () => {
  const t = await parseTable(Buffer.from([HEAD, 'S;;Shirt Basic;Bio-Baumwolle.;;;;;;;;', 'S-R;;Shirt Rot;;21,00;;;;;S;Rot;', 'S-B;;Shirt Blau;;22,00;;;;;S;Blau;', 'S-G;;Shirt Grün;;22,00;;;;;S;Grün;', 'S-R;;Shirt Rot doppelt;;99,00;;;;;S;Rot;'].join('\n')), 'x.csv');
  const r = planShopifyImport(t, MAPPING, shirtCat(), { updatePrices: true }, meta);
  assert.equal(r.payload.plans.length, 1);
  const p = r.payload.plans[0]; assert.ok(p.kind === 'update');
  assert.equal(p.product.title, 'Shirt Basic'); assert.match(String(p.product.descriptionHtml), /Bio-Baumwolle/);
  assert.deepEqual(p.variants.map(v => [v.id, v.price]), [['gid://shopify/ProductVariant/11', 21], ['gid://shopify/ProductVariant/12', 22]]);
  assert.ok(r.cs.skipped.some(s => /S-G.*propose_variants/.test(s.reason)), JSON.stringify(r.cs.skipped));
  assert.ok(r.cs.skipped.some(s => /Zeile 6.*doppelt in der Datei/.test(s.reason)), JSON.stringify(r.cs.skipped));
  assert.throws(() => planShopifyImport(t, MAPPING, shirtCat(), { mode: 'create' }, meta), /Nichts zu importieren/);
});

test('duplicate product numbers in the file: only the first row is created', async () => {
  const t = await parseTable(Buffer.from([HEAD, 'NEU-1;;Kanne;;30,00;;;;;;;', 'NEU-1;;Kanne 2;;31,00;;;;;;;'].join('\n')), 'x.csv');
  const r = planShopifyImport(t, MAPPING, shirtCat(), {}, meta);
  assert.equal(r.stats.create, 1); assert.match(r.cs.skipped[0].reason, /Zeile 3.*doppelt/);
});

test('against the fake: mug with 4 variants, two prices via parent product file, new variant skipped; exact undo', async () => {
  const csv = [HEAD, 'HH-BECHER;;Becher „Morgen“;;;;;;;;;', 'HH-BECHER-SAND-250;;Becher Sand 250;;19,00;;;;;HH-BECHER;Sand;', 'HH-BECHER-SAND-350;;Becher Sand 350;;20,00;;;;;HH-BECHER;Sand;', 'HH-BECHER-ROT-250;;Becher Rot;;19,00;;;;;HH-BECHER;Rot;'].join('\n');
  const f = saveFile(Buffer.from(csv), 'becher.csv'), before = snap();
  const out = json(await call('propose_import', { fileId: f.fileId, title: 'Becherpreise', reason: 'Neue Preise', mapping: MAPPING, options: { updatePrices: true, mode: 'update' } }));
  assert.equal(out.status, 'applied', JSON.stringify(out)); assert.equal(out.updated.length, 1);
  assert.ok(out.skipped.some((s: string) => /HH-BECHER-ROT-250.*propose_variants/.test(s)), JSON.stringify(out.skipped));
  const becher = fake.state.findProductByHandle('becher-morgen')!, vs = fake.state.productVariants(becher);
  assert.equal(becher.title, 'Becher „Morgen“');
  assert.deepEqual(vs.map(v => [v.sku, v.price]), [['HH-BECHER-SAND-250', '19.00'], ['HH-BECHER-SAND-350', '20.00'], ['HH-BECHER-SALBEI-250', '18.00'], ['HH-BECHER-NACHT-350', '18.00']]);
  const r = await shopify.undo(lastResult().undo!); assert.ok(r.every(x => x.ok), JSON.stringify(r));
  assert.deepEqual(snap(), before, 'reverted exactly');
});

test('variant family: gross 0.00 of a variant stays 0 (no fallback to the parent row); a row without price takes the parent row price', async () => {
  const t = await parseTable(Buffer.from([HEAD, 'TUCH;;Tuch „Priel“;Baumwolle.;19,00;;;;;;;', 'TUCH-G;;Tuch Gratis;;0,00;;;;;TUCH;Gratis;', 'TUCH-S;;Tuch Sand;;;;;;;TUCH;Sand;'].join('\n')), 'x.csv');
  const r = planShopifyImport(t, MAPPING, shirtCat(), {}, meta);
  const fam = r.payload.plans[0]; assert.ok(fam.kind === 'create' && fam.variants);
  assert.deepEqual(fam.variants.map(v => [v.sku, v.price]), [['TUCH-G', 0], ['TUCH-S', 19]]);
});

test('against the fake: update with image (product without image) and joining a collection; exact undo. Abort after productCreate removes the half-created product immediately', async () => {
  const { ShopifyClient } = await import('../../../../src/server/platform/shopify/client');
  const { applyShopifyImport } = await import('../../../../src/server/platform/shopify/import');
  json(await call('propose_collection', { title: 'K', reason: 'K', collections: [{ name: 'Import-Ziel', productIds: [] }] }));
  const ziel = [...fake.state.collections.values()].find(c => c.title === 'Import-Ziel')!;
  const plaid = fake.state.findProductByHandle('plaid-duene')!;
  assert.equal(plaid.mediaIds.length, 0); assert.ok(!ziel.productIds.includes(plaid.id));
  const before = snap();
  const f = saveFile(Buffer.from([HEAD, 'HH-PLAID-DUENE;;Plaid „Düne“;;;;;Import-Ziel;https://cdn.example.com/plaid.jpg;;;'].join('\n')), 'plaid.csv');
  const out = json(await call('propose_import', { fileId: f.fileId, title: 'Plaid', reason: 'Bild + Kollektion', mapping: MAPPING, options: { mode: 'update' } }));
  assert.equal(out.status, 'applied', JSON.stringify(out)); assert.equal(out.updated.length, 1);
  assert.equal(fake.state.findProductByHandle('plaid-duene')!.mediaIds.length, 1, 'image imported');
  assert.ok(fake.state.collections.get(ziel.id)!.productIds.includes(plaid.id), 'added to collection');
  const r = await shopify.undo(lastResult().undo!); assert.ok(r.every(x => x.ok), JSON.stringify(r));
  assert.deepEqual(snap(), before, 'image removed, collection left');
  // Variant family: productVariantsBulkCreate reports userErrors → the created product is removed again immediately
  const faulty = new ShopifyClient(() => ({ origin: fake.url, domain: '127.0.0.1', apiVersion: '2026-10', token: fake.token, publicUrl: '', endpoint: `${fake.url}/admin/api/2026-10/graphql.json` }), { fetch: async (u, i) => {
    if (typeof i?.body === 'string' && /\bproductVariantsBulkCreate\(/.test(JSON.parse(i.body).query)) return new Response(JSON.stringify({ data: { productVariantsBulkCreate: { userErrors: [{ field: ['x'], message: 'Testfehler' }] } } }), { status: 200 });
    return fetch(u, i);
  } });
  const t = await parseTable(Buffer.from([HEAD, 'TUCH-S;;Tuch „Priel“ Sand;Baumwolle.;19,00;;;;;TUCH;Sand;', 'TUCH-B;;Tuch „Priel“ Blau;Baumwolle.;19,00;;;;;TUCH;Blau;'].join('\n')), 'tuch.csv');
  const { cs, payload } = planShopifyImport(t, MAPPING, shirtCat(), {}, meta);
  const res = await applyShopifyImport(faulty, cs, payload, new Set(cs.items.map(i => i.id)));
  assert.equal(res.counts?.failed, 1); assert.match(String(res.results[0].error), /Testfehler.*angelegtes Produkt wieder entfernt/);
  assert.deepEqual(res.undo, []);
  assert.ok(![...fake.state.products.values()].some(p => p.title === 'Tuch „Priel“'), 'no half-created product');
  assert.deepEqual(snap(), before);
});

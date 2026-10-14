// Shopware adapter against a fake read client: tools (pagination, filters, caps, read_page origin, proposal → change set),
// pages (preview data, publish check) and lookup. No shop needed; the fake records every search.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChangeSet } from '@/lib/protocol';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-shopware-'));
delete process.env.SHOP_PLATFORM;

const { shopwareTools, loadRawBlocks } = await import('../../../../src/server/platform/shopware/tools');
const { shopwarePages } = await import('../../../../src/server/platform/shopware/pages');
const { shopwareLookup, asLookup } = await import('../../../../src/server/platform/shopware/lookup');
const { stageImage } = await import('../../../../src/server/media');
type Session = import('../../../../src/server/sessions').Session;
type ReadOnlyShopware = import('../../../../src/server/shopware').ReadOnlyShopware;
type ShopReader = import('../../../../src/server/shopware').ShopReader;
type SwEntity = import('../../../../src/server/shopware').SwEntity;
type Criteria = import('../../../../src/server/policy').Criteria;

// ---- Fake shop: 120 parent products (price = sequence number), categories, media, one Shopping Experience ----
const pad = (n: number) => String(n).padStart(3, '0');
const products: SwEntity[] = Array.from({ length: 120 }, (_, i) => ({ id: `p${pad(i + 1)}`, productNumber: `P-${pad(i + 1)}`, name: `Produkt ${i + 1}`, translated: { name: `Produkt ${i + 1}`, description: '<p>Text</p>' }, parentId: null, active: i % 10 !== 0, stock: i, price: [{ currencyId: 'cur', gross: i + 1, net: (i + 1) / 1.19 }], tax: { taxRate: 19 }, coverId: null, categoryTree: i < 10 ? ['c1'] : null, categoriesRo: i < 10 ? [{ id: 'c1' }] : [] }));
const categories: SwEntity[] = [{ id: 'c1', name: 'Wohnen', translated: { name: 'Wohnen', breadcrumb: ['Home', 'Wohnen'] }, type: 'page', level: 2, cmsPageId: 'cms1', active: true }];
const cmsPages: SwEntity[] = [{ id: 'cms1', name: 'Wohnen Layout', type: 'product_list', sections: [
  { type: 'default', position: 0, blocks: [{ type: 'text', position: 0, slots: [{ slot: 'content', type: 'text', config: { content: { source: 'static', value: '<p>Intro</p>' } } }] }, { type: 'image', position: 1, slots: [{ slot: 'image', type: 'image', config: { media: { source: 'static', value: 'a'.repeat(32) } } }] }] },
  { type: 'default', position: 1, blocks: [{ type: 'product-listing', position: 0, slots: [{ slot: 'content', type: 'product-listing', config: {} }] }] },
] }];
const media: SwEntity[] = [{ id: 'm1', url: 'https://shop.example/media/m1.jpg', fileName: 'm1', fileExtension: 'jpg', mimeType: 'image/jpeg' }, { id: 'a'.repeat(32), url: 'https://shop.example/media/reuse.jpg', fileName: 'reuse', fileExtension: 'jpg', mimeType: 'image/jpeg' }];
const salesChannels: SwEntity[] = [{ id: 'sc1', name: 'Storefront', translated: { name: 'Storefront' }, languageId: 'lang1', navigationCategoryId: 'c1', domains: [{ url: 'https://shop.example', languageId: 'lang1' }] }];
const TABLES: Record<string, SwEntity[]> = { product: products, category: categories, 'cms-page': cmsPages, media, 'sales-channel': salesChannels };

type Filter = { type: string; field: string; value?: unknown; parameters?: Record<string, number> };
const matches = (r: SwEntity, f: Filter): boolean => {
  const v = f.field === 'price' ? r.price?.[0]?.gross : f.field === 'categoriesRo.id' ? r.categoriesRo?.map((c: SwEntity) => c.id) : r[f.field];
  if (f.type === 'equals') return Array.isArray(v) ? v.includes(f.value) : v === f.value;
  if (f.type === 'equalsAny') return (f.value as unknown[]).includes(v);
  if (f.type === 'range') return typeof v === 'number' && (f.parameters?.gte == null || v >= f.parameters.gte) && (f.parameters?.lte == null || v <= f.parameters.lte);
  return true;
};
const calls: { op: 'search' | 'get'; entity: string; criteria: Criteria }[] = [];
const fake: ShopReader = {
  base: 'http://shopware:8000',
  async search(entity, criteria = {}) {
    calls.push({ op: 'search', entity, criteria });
    let rows = TABLES[entity] ?? [];
    if (Array.isArray(criteria.ids)) rows = rows.filter(r => (criteria.ids as string[]).includes(r.id));
    for (const f of (criteria.filter ?? []) as Filter[]) rows = rows.filter(r => matches(r, f));
    const limit = Number(criteria.limit ?? 25), page = Number(criteria.page ?? 1);
    return { data: rows.slice((page - 1) * limit, page * limit), total: rows.length };
  },
  async get(entity, id, criteria = {}) { calls.push({ op: 'get', entity, criteria: { ...criteria, ids: [id] } }); return (TABLES[entity] ?? []).find(r => r.id === id) ?? null; },
  async salesChannels() { return salesChannels; },
  async req(method, p) { throw new Error(`Fake: ${method} ${p} nicht unterstützt`); },
};
const since = () => { const n = calls.length; return () => calls.slice(n); };

type Res = { isError?: boolean; content: { text: string }[] };
const requested: ChangeSet[] = [];
let fetched: { url: string; init?: RequestInit }[] = [];
let fetchResponse: () => Partial<Response> = () => ({ ok: true, status: 200, url: '', text: async () => '<html><head><title>Wohnen</title></head><body><h1>Wohnen</h1></body></html>' });
const session = {
  id: 'chat-sw', platform: 'shopware', sw: fake as unknown as ReadOnlyShopware, reader: fake, lookup: shopwareLookup(fake),
  storefrontFetch: async (url: string, init?: RequestInit) => { fetched.push({ url, init }); return fetchResponse() as Response; },
  requestChange: async (cs: ChangeSet) => { requested.push(cs); return { status: 'applied' as const, message: 'ok', applied: cs.items.length }; },
} as unknown as Session;
const tools = shopwareTools(session);
const call = async (name: string, args: Record<string, unknown>) => { const t = tools.find(x => x.name === name); assert.ok(t, `tool ${name} missing`); return (await t.handler(args, {})) as Res; };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (r: Res): any => { assert.equal(r.isError ?? false, false, r.content[0].text); return JSON.parse(r.content[0].text); };

// ================= tools =================
test('list_products: offset is rounded to the page and reported honestly, nextOffset up to total', async () => {
  const after = since();
  const r = json(await call('list_products', { limit: 50, offset: 30 }));
  const c = after().find(x => x.entity === 'product')!.criteria;
  assert.equal(c.limit, 50); assert.equal(c.page, 1);
  assert.equal(r.offset, 0, 'reported offset = page actually read'); assert.match(r.note, /offset auf 0 gerundet/);
  assert.equal(r.total, 120); assert.equal(r.returned, 50); assert.equal(r.nextOffset, 50);
  assert.equal(r.products[0].number, 'P-001'); assert.equal(r.products[0].gross, 1);
  const last = json(await call('list_products', { limit: 50, offset: 100 }));
  assert.deepEqual([last.offset, last.returned, last.nextOffset, last.note], [100, 20, undefined, undefined]);
  // details: cap 25, page accordingly
  const d = json(await call('list_products', { limit: 50, offset: 25, details: true }));
  assert.deepEqual([d.offset, d.returned, d.nextOffset], [25, 25, 50]);
  assert.equal(d.products[0].description, 'Text');
});

test('list_products: price range filters server-side (range on price), total matches', async () => {
  const after = since();
  const r = json(await call('list_products', { minPrice: 100, maxPrice: 110, limit: 5 }));
  const c = after().find(x => x.entity === 'product')!.criteria;
  assert.deepEqual((c.filter as Filter[]).find(f => f.field === 'price'), { type: 'range', field: 'price', parameters: { gte: 100, lte: 110 } });
  assert.deepEqual([r.total, r.returned, r.nextOffset], [11, 5, 5]);
  assert.equal(r.products[0].gross, 100);
  const only = json(await call('list_products', { maxPrice: 3 }));
  assert.deepEqual((only.products as { gross: number }[]).map(p => p.gross), [1, 2, 3]);
  assert.deepEqual(json(await call('list_products', { minPrice: 1000 })), { total: 0, returned: 0, offset: 0, products: [] });
});

test('search_*: limit is capped (no huge responses)', async () => {
  const after = since();
  json(await call('search_products', { limit: 5000 }));
  json(await call('search_categories', { limit: 5000 }));
  json(await call('search_media', { limit: -3 }));
  json(await call('search_products', {}));
  const lims = after().filter(x => x.op === 'search').map(x => [x.entity, x.criteria.limit]);
  assert.deepEqual(lims, [['product', 50], ['category', 100], ['media', 1], ['product', 15]]);
});

test('search_categories returns what the description promises (no product count)', async () => {
  const t = tools.find(x => x.name === 'search_categories')!;
  assert.doesNotMatch(t.description, /Produktanzahl/);
  const r = json(await call('search_categories', { term: 'Wohnen' }));
  assert.deepEqual(Object.keys(r[0]).sort(), ['cmsPage', 'description', 'id', 'name', 'path', 'type']);
  assert.equal(r[0].path, 'Home > Wohnen');
});

test('get_cms_page: blockIndex matches the order of loadRawBlocks (source for reuse)', async () => {
  const r = json(await call('get_cms_page', { categoryId: 'c1' }));
  assert.equal(r.id, 'cms1');
  const raw = await loadRawBlocks(fake, 'cms1');
  const flat = (r.sections as { blocks: { blockIndex: number; block: string }[] }[]).flatMap(s => s.blocks);
  assert.deepEqual(flat.map(b => b.blockIndex), [0, 1, 2]);
  assert.deepEqual(flat.map(b => b.block), raw.map(b => b.type));
  assert.equal(raw[1].slots[0].config?.media && (raw[1].slots[0].config.media as { value: string }).value, 'a'.repeat(32));
  assert.match(r.hint, /cmsPageId:"cms1"/);
});

test('read_page: shop domains only, also after redirect', async () => {
  fetched = [];
  const foreign = await call('read_page', { url: 'https://fremd.example/aktion' });
  assert.equal(foreign.isError, true); assert.match(foreign.content[0].text, /nur Seiten des eigenen Shops/);
  assert.equal(fetched.length, 0, 'foreign URL is not fetched');
  const ok = json(await call('read_page', { url: 'https://shop.example/wohnen/' }));
  assert.equal(ok.url, 'https://shop.example/wohnen/'); assert.equal(ok.title, 'Wohnen');
  // shop redirects to a foreign address: not passed to the AI
  fetchResponse = () => ({ ok: true, status: 200, url: 'https://fremd.example/landing', text: async () => '<html><title>Fremd</title></html>' });
  const redirected = await call('read_page', { url: 'https://shop.example/aktion' });
  assert.equal(redirected.isError, true); assert.match(redirected.content[0].text, /fremd\.example/);
  // redirect within the shop (e.g. to the internal address) is fine
  fetchResponse = () => ({ ok: true, status: 200, url: 'http://shopware:8000/wohnen/', text: async () => '<html><title>Intern</title></html>' });
  assert.equal(json(await call('read_page', { url: 'https://shop.example/wohnen' })).title, 'Intern');
});

test('propose_product_changes: nothing is written, change set goes to session.requestChange', async () => {
  const r = json(await call('propose_product_changes', { title: 'Bestand', reason: 'Inventur', changes: [{ id: 'p001', fields: { stock: 5 } }, { id: 'p002', fields: { price: { percent: -10, round: '.99' } } }] }));
  assert.equal(r.status, 'applied');
  const cs = requested.at(-1)!;
  assert.equal(cs.kind, 'products'); assert.equal(cs.entity, 'product');
  assert.deepEqual(cs.items.map(i => [i.entityId, i.field, i.before, i.after]), [['p001', 'stock', '0', '5'], ['p002', 'price', '2,00 €', '1,99 €']]);
  assert.equal(cs.title, 'Bestand');
});

// ================= pages =================
test('previewData: staged images → /staged/<file>, media in one search, all slider products', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
  const staged = stageImage(png, 'image/png', { name: 'hero', alt: 'Hero' });
  const ids = products.slice(0, 70).map(p => p.id);
  const after = since();
  const ctx = await shopwarePages.previewData(session, { name: 'LP', type: 'landingpage', previewCategoryId: 'c1', sections: [{ blocks: [
    { type: 'text-hero', image: { mediaId: staged.mediaId, alt: 'Hero' } }, { type: 'image-text', image: { mediaId: 'm1' }, image2: { mediaId: 'fehlt' } },
    { type: 'product-slider', productIds: ids.slice(0, 16) }, { type: 'product-slider', productIds: ids.slice(16, 32) }, { type: 'product-slider', productIds: ids.slice(32, 70) },
  ] }] });
  assert.equal(ctx.imageUrl!({ mediaId: staged.mediaId }), `/staged/${staged.fileName}`);
  assert.equal(ctx.imageUrl!({ mediaId: 'm1' }), 'https://shop.example/media/m1.jpg');
  assert.equal(ctx.imageUrl!({ mediaId: 'fehlt' }), null);
  assert.equal(ctx.imageUrl!('https://x.example/a.jpg'), 'https://x.example/a.jpg');
  assert.equal(Object.keys(ctx.products!).length, 70, 'all slider products (the 8 active ones of the preview category are already included)');
  assert.equal(ctx.products!.p001.price, '1,00 €');
  const c = after();
  assert.deepEqual(c.filter(x => x.entity === 'media').map(x => [x.op, (x.criteria.ids as string[]).length]), [['search', 2]], 'media collected in one search');
  assert.deepEqual(c.filter(x => x.entity === 'product' && Array.isArray(x.criteria.ids)).map(x => (x.criteria.ids as string[]).length), [50, 20]);
});

test('buildPublish: missing details are named, important link findings end up as a warning on the change set', async () => {
  const spec = { name: 'Wohnen', type: 'product_list' as const, sections: [{ blocks: [{ type: 'text', html: '<p>Hi</p>', linkUrl: 'javascript:alert(1)' }, { type: 'product-listing' }] }] };
  await assert.rejects(shopwarePages.buildPublish(session, spec, { target: 'landingpage', url: 'aktion' }), /url und salesChannelId fehlen/);
  await assert.rejects(shopwarePages.buildPublish(session, spec, { target: 'category' }), /categoryId fehlt/);
  await assert.rejects(shopwarePages.buildPublish(session, spec, { target: 'product', productIds: [] }), /productIds fehlt/);
  const { cs, payload } = await shopwarePages.buildPublish(session, spec, { target: 'category', categoryId: 'c1' });
  assert.equal(cs.kind, 'page'); assert.equal(cs.atomic, true);
  assert.ok(cs.items[0].warn.some(w => /Unsicherer Link/.test(w)), cs.items[0].warn.join('|'));
  assert.deepEqual(cs.items.map(i => [i.label, i.fieldLabel, i.after]), [['Neues CMS-Layout', 'Anlegen', 'Wohnen · product_list · 2 Blöcke'], ['Kategorie „Wohnen“', 'Layout', 'Wohnen']]);
  assert.equal((payload as { args: { categoryId: string } }).args.categoryId, 'c1');
});

// ================= Lookup =================
test('shopwareLookup: IDs first, then numbers; no fetch without input; asLookup passes through', async () => {
  const lookup = shopwareLookup(fake);
  const after = since();
  assert.deepEqual(await lookup.findProducts({ ids: ['p002'], numbers: ['P-001'] }), [{ id: 'p002', number: 'P-002', name: 'Produkt 2' }, { id: 'p001', number: 'P-001', name: 'Produkt 1' }]);
  assert.deepEqual(await lookup.findProducts({}), []);
  assert.equal(after().length, 2, 'exactly two searches, none for empty input');
  assert.deepEqual(await lookup.getProduct('p050'), { id: 'p050', number: 'P-050', name: 'Produkt 50', ean: undefined, categoryIds: [] });
  assert.deepEqual((await lookup.getProduct('p001'))?.categoryIds, ['c1']);
  assert.equal(await lookup.getProduct('nix'), null);
  assert.deepEqual(await lookup.findCategories(['c1']), [{ id: 'c1', name: 'Wohnen' }]);
  assert.equal(await lookup.mediaUrl('m1'), 'https://shop.example/media/m1.jpg');
  assert.equal(asLookup(lookup), lookup);
  assert.equal(typeof asLookup(fake).mapUrls, 'function');
});

test('Preview: without a sample product/category a real active product with cover image is chosen; given values are kept', async () => {
  const { withPreviewDefaults } = await import('../../../../src/server/platform/shopware/pages');
  const calls: Record<string, unknown>[] = [];
  const sw = { search: async (_e: string, c: Record<string, unknown>) => { calls.push(c); return { data: [{ id: 'p-real', categoryIds: ['c-real'] }] }; } } as never;
  const pdp = { name: 'x', type: 'product_detail', sections: [] } as never;
  assert.equal((await withPreviewDefaults(sw, pdp)).previewProductId, 'p-real');
  const f = JSON.stringify(calls[0].filter);
  assert.match(f, /"active"/); assert.match(f, /"coverId"/); assert.match(f, /"parentId"/);
  const list = await withPreviewDefaults(sw, { name: 'x', type: 'product_list', sections: [] } as never);
  assert.equal(list.previewCategoryId, 'c-real'); assert.equal(list.previewProductId, undefined);
  const given = { name: 'x', type: 'product_detail', previewProductId: 'mine', sections: [] } as never;
  assert.equal(await withPreviewDefaults(sw, given), given, 'given product is kept');
  assert.equal((await withPreviewDefaults(sw, { name: 'x', type: 'landingpage', sections: [] } as never)).previewProductId, undefined);
  const broken = { search: async () => { throw new Error('Shop weg'); } } as never;
  assert.equal((await withPreviewDefaults(broken, pdp)).previewProductId, undefined, 'error → placeholder instead of abort');
});

test('Neutral product rows (Shopware): default currency, texts from translated, stock, cover image; cap and pages', async () => {
  const { toNeutral, scanNeutral } = await import('../../../../src/server/platform/shopware/scan');
  const { DEFAULT_CURRENCY } = await import('../../../../src/server/changes');
  const n = toNeutral({ id: 'p1', productNumber: 'A-1', name: 'Roh', translated: { name: 'Vase', description: '<p>Text</p>', metaTitle: ' T ' }, stock: 4, coverId: 'm1',
    price: [{ currencyId: 'fremd', gross: 1 }, { currencyId: DEFAULT_CURRENCY, gross: 19.9, listPrice: { gross: 25 } }] } as never);
  assert.deepEqual(n, { id: 'p1', name: 'Vase', label: 'Vase (A-1)', description: '<p>Text</p>', metaTitle: 'T', metaDescription: '', price: 19.9, listPrice: 25, stock: 4, hasImage: true });
  const pages: number[] = [];
  const sw = { search: async (_e: string, c: { page?: number; limit?: number }) => {
    pages.push(c.page ?? 1);
    const data = c.page === 1 ? Array.from({ length: 250 }, (_, i) => ({ id: `a${i}`, productNumber: `N${i}`, name: `P${i}`, stock: 1, coverId: null })) : [{ id: 'z', productNumber: 'Z', name: 'Z', stock: 0, coverId: null }];
    return { data, total: 251 };
  } } as never;
  const s = await scanNeutral(sw);
  assert.equal(s.rows.length, 251); assert.equal(s.total, 251); assert.equal(s.capped, false); assert.deepEqual(pages, [1, 2]);
  assert.equal(await scanNeutral(sw), s, 'once per read client');
  assert.equal(s.rows[0].hasImage, false);
});

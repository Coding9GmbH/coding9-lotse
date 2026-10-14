import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ShopReader, SwEntity } from '../../../src/server/shopware';
import { undoOps } from '../../../src/server/changes';
import type { Shopware } from '../../../src/server/shopware';
import { applyVariants, buildVariantsChangeSet, combinations, loadFamily, nextSuffix, variantSnapshot, type NewVariant, type VariantsPayload } from '../../../src/server/features/variant-matrix';

const hex = (n: number) => n.toString(16).padStart(32, '0');
const PARENT = hex(1), FARBE = hex(10), SAND = hex(11), SALBEI = hex(12), GROESSE = hex(20), S = hex(21), M = hex(22);
const group = (id: string, name: string, options: [string, string][]) => ({ id, name, translated: { name }, options: options.map(([oid, n]) => ({ id: oid, name: n, translated: { name: n }, groupId: id })) });
const GROUPS = [group(FARBE, 'Farbe', [[SAND, 'Sand'], [SALBEI, 'Salbei']]), group(GROESSE, 'Größe', [[S, 'S'], [M, 'M']])];
const parent = { id: PARENT, productNumber: 'HH-PLAID-130', name: 'Plaid', translated: { name: 'Plaid' }, active: true, stock: 40, price: [{ currencyId: 'eur', gross: 89, net: 74.79 }], tax: { taxRate: 19 }, configuratorSettings: [{ id: 'cs1', option: { ...GROUPS[0].options[0], group: GROUPS[0] } }] };
const child = (id: string, n: number, opts: SwEntity[], extra: SwEntity = {}) => ({ id, parentId: PARENT, productNumber: `HH-PLAID-130.${n}`, stock: 5, active: null, price: null, options: opts.map(o => ({ ...o, group: GROUPS.find(g => g.id === o.groupId) })), ...extra });

function fakeReader(children: SwEntity[], taken: string[] = []): ShopReader {
  return {
    base: 'http://shop.test',
    get: async (entity: string, id: string) => (entity === 'product' ? (id === PARENT ? parent : children.find(c => c.id === id) ?? null) : entity === 'property-group' ? GROUPS.find(g => g.id === id) ?? null : null),
    search: async (entity: string, c?: { filter?: { field: string; value: unknown }[] }) => {
      const f = c?.filter?.[0];
      if (entity === 'property-group') return { data: GROUPS.filter(g => g.name.toLowerCase().includes(String(f?.value).toLowerCase())) };
      if (entity === 'product' && f?.field === 'parentId') return { data: children, total: children.length };
      if (entity === 'product' && f?.field === 'productNumber') return { data: (f.value as string[]).filter(n => taken.includes(n)).map(productNumber => ({ productNumber })) };
      return { data: [] };
    },
    salesChannels: async () => [], req: async () => null,
  } as unknown as ShopReader;
}

test('combinations: Cartesian product, nextSuffix: next free suffix', () => {
  assert.deepEqual(combinations([['1', '2'], ['a', 'b']]), [['1', 'a'], ['1', 'b'], ['2', 'a'], ['2', 'b']]);
  assert.deepEqual(combinations([]), [[]]);
  assert.equal(nextSuffix('HH-1', ['HH-1.1', 'HH-1.7', 'HH-1.x', 'HH-10.9']), 8);
  assert.equal(nextSuffix('HH-1', []), 1);
});

test('create variants: combinations, existing ones skipped, new option, numbers, overrides', async () => {
  const ro = fakeReader([child(hex(100), 1, [GROUPS[0].options[0], GROUPS[1].options[0]])], ['HH-PLAID-130.3']);
  const { cs, payload } = await buildVariantsChangeSet(ro, { title: 'Varianten', reason: 'r', productId: PARENT, create: {
    axes: [{ group: 'farbe', options: ['Sand', 'Salbei', 'Rost'] }, { group: GROESSE, options: [S, 'm'] }],
    defaults: { stock: 3 }, overrides: [{ options: ['Rost', 'M'], price: 99, active: true }],
  } });
  const p = payload as VariantsPayload;
  assert.equal(p.parentId, PARENT); assert.equal(p.newGroups.length, 0);
  assert.deepEqual(p.newOptions.map(o => [o.groupId, o.name, o.position]), [[FARBE, 'Rost', 3]]);
  const created = cs.items.filter(i => i.field === 'create');
  // 6 combinations − 1 existing (Sand/S); number .3 is taken shop-wide → counting continues
  assert.equal(created.length, 5);
  assert.deepEqual(cs.skipped.map(s => s.reason), ['Farbe: Sand / Größe: S: Variante existiert bereits']);
  const nv = created.map(i => i.afterRaw as NewVariant);
  assert.deepEqual(nv.map(v => v.productNumber), ['HH-PLAID-130.2', 'HH-PLAID-130.7', 'HH-PLAID-130.4', 'HH-PLAID-130.5', 'HH-PLAID-130.6']);
  const rostM = created.find(i => i.label.endsWith('Farbe: Rost / Größe: M'))!.afterRaw as NewVariant;
  assert.deepEqual([rostM.price, rostM.stock, rostM.active], [99, 3, true]);
  assert.ok(nv.filter(v => v !== rostM).every(v => v.price === null && v.active === null && v.stock === 3));
  assert.match(created[0].after, /89,00 € \(geerbt\) · Bestand 3 · aktiv \(geerbt\)/);
  assert.ok(cs.items.some(i => i.id.startsWith('opt:') && i.entity === 'info'));
  assert.equal(cs.kind, 'variants');
});

test('change variants: rule on inherited price, null = inherit, delete + updates', async () => {
  const a = child(hex(100), 1, [GROUPS[1].options[0]]), b = child(hex(101), 2, [GROUPS[1].options[1]], { price: [{ currencyId: 'eur', gross: 95 }], active: true });
  const { cs } = await buildVariantsChangeSet(fakeReader([a, b]), { title: 't', reason: 'r', productId: hex(100), // variant id → whole family
    updateAll: { price: { percent: -10, round: '.99' } }, update: [{ id: b.id, price: null, stock: 9 }, { id: hex(999), stock: 1 }], remove: [] });
  const byId = Object.fromEntries(cs.items.map(i => [i.id, i]));
  assert.equal(byId[`${a.id}:price`].before, '89,00 € (geerbt)');
  assert.equal(byId[`${a.id}:price`].afterRaw, 79.99);
  assert.equal(byId[`${b.id}:price`].afterRaw, null);
  assert.match(byId[`${b.id}:price`].after, /erbt vom Hauptprodukt/);
  assert.equal(byId[`${b.id}:stock`].afterRaw, 9);
  assert.match(cs.skipped[0].reason, /keine Variante/);

  const del = await buildVariantsChangeSet(fakeReader([a, b]), { title: 't', reason: 'r', productId: PARENT, remove: [b.id], update: [{ id: b.id, stock: 1 }] });
  assert.equal(del.cs.items.find(i => i.field === 'delete')?.entityId, b.id);
  assert.match(del.cs.skipped[0].reason, /wird gelöscht/);
  await assert.rejects(buildVariantsChangeSet(fakeReader([a]), { title: 't', reason: 'r', productId: PARENT, update: [{ id: a.id, price: null }] }), /Keine Änderung nötig/);
});

test('variantSnapshot: own values, assignments and translations for exact recreation', () => {
  const snap = variantSnapshot({ id: 'v', parentId: 'p', productNumber: 'X.1', stock: 2, active: null, price: null, ean: '123', options: [{ id: 'o1', name: 'S' }], properties: [], media: [{ id: 'pm', mediaId: 'm', position: 0, media: {} }], coverId: 'pm',
    translations: [{ languageId: 'de', name: null, description: null }, { languageId: 'en', name: 'Throw S' }], visibilities: [], prices: [] });
  assert.deepEqual(snap, { parentId: 'p', productNumber: 'X.1', stock: 2, ean: '123', coverId: 'pm', options: [{ id: 'o1' }], properties: [], categories: [], tags: [], media: [{ id: 'pm', mediaId: 'm', position: 0 }], translations: [{ languageId: 'en', name: 'Throw S' }] });
});

test('variantSnapshot: customFields only in translations, otherwise Shopware overwrites the own texts of the system language', () => {
  const v = { id: 'v', parentId: 'p', productNumber: 'X.2', stock: 1, customFields: { foo: 1 }, translated: { name: 'Eigener Name' },
    translations: [{ languageId: 'de', name: 'Eigener Name', description: 'Desc', customFields: { foo: 1 } }] };
  const snap = variantSnapshot(v);
  assert.equal('customFields' in snap, false);
  assert.deepEqual(snap.translations, [{ languageId: 'de', name: 'Eigener Name', description: 'Desc', customFields: { foo: 1 } }]);
  // without loaded translations, customFields is kept
  assert.deepEqual(variantSnapshot({ ...v, translations: undefined }).customFields, { foo: 1 });
});

test('loadFamily: offset is rounded to a multiple of limit and returned that way', async () => {
  const kids = Array.from({ length: 7 }, (_, i) => child(hex(200 + i), i + 1, [GROUPS[1].options[0]]));
  const ro = fakeReader(kids), pages: number[] = [], search = ro.search;
  ro.search = async (e, c) => { if (e === 'product') pages.push(Number((c as { page?: number })?.page ?? 1)); return search(e, c); };
  const r = await loadFamily(ro, PARENT, { limit: 2, offset: 3 });
  assert.equal(r.offset, 2, 'offset 3 with limit 2 = page 2 = rows from 2');
  assert.deepEqual(pages, [2]);
  assert.equal((await loadFamily(ro, PARENT, { limit: 2, offset: 4 })).offset, 4);
});

/** Fake shop for the executor: tables per entity, writes like the Admin API (create/update/DELETE), also for undoOps */
function fakeShop(products: SwEntity[], settings: SwEntity[]) {
  const db: Record<string, Map<string, SwEntity>> = {
    product: new Map(products.map(p => [p.id, { ...p }])), 'property-group': new Map(GROUPS.map(g => [g.id, { ...g }])),
    'property-group-option': new Map(GROUPS.flatMap(g => g.options).map(o => [o.id, { ...o }])), 'product-configurator-setting': new Map(settings.map(s => [s.id, { ...s }])), 'seo-url': new Map(),
  };
  const tbl = (e: string) => { const m = db[e]; if (!m) throw new Error(`unbekannte Entität ${e}`); return m; };
  const log: string[] = [];
  const sw = {
    create: async (e: string, d: SwEntity) => { log.push(`create ${e}`); tbl(e).set(d.id, { ...d }); },
    update: async (e: string, id: string, d: SwEntity) => { log.push(`update ${e} ${id} ${JSON.stringify(d)}`); const cur = tbl(e).get(id); if (!cur) throw new Error('404'); tbl(e).set(id, { ...cur, ...d }); },
    get: async (e: string, id: string) => tbl(e).get(id) ?? null,
    search: async (e: string, c: { ids?: string[]; filter?: { type: string; field: string; value: unknown }[] } = {}) => {
      let rows = [...tbl(e).values()];
      if (c.ids) rows = rows.filter(r => c.ids!.includes(r.id));
      for (const f of c.filter ?? []) if (f.type === 'equals') rows = rows.filter(r => r[f.field] === f.value);
      return { data: rows, total: rows.length };
    },
    req: async (m: string, p: string) => { log.push(`${m} ${p}`); const [, e, id] = p.split('/'); if (m === 'DELETE' && !tbl(e).delete(id)) throw Object.assign(new Error('404'), { status: 404 }); return null; },
  } as unknown as Shopware;
  /** Comparable state (variant snapshots omit null fields and carry options only as ids) */
  const state = () => ({
    products: [...db.product.values()].map(p => ({ id: p.id, parentId: p.parentId ?? null, number: p.productNumber, stock: p.stock ?? null, active: p.active ?? null, gross: p.price?.[0]?.gross ?? null, list: p.price?.[0]?.listPrice?.gross ?? null, options: (p.options ?? []).map((o: SwEntity) => o.id).sort() })).sort((x, y) => x.id.localeCompare(y.id)),
    settings: [...db['product-configurator-setting'].values()].map(s => `${s.id}:${s.optionId}`).sort(), groups: [...db['property-group'].keys()].sort(), options: [...db['property-group-option'].keys()].sort(),
  });
  return { db, sw, log, state };
}

test('applyVariants: create (new property/option, configurator), change (fix/inherit), delete with snapshot; undo restores everything', async () => {
  const a = child(hex(100), 1, [GROUPS[0].options[0], GROUPS[1].options[0]]); // Sand/S, inherits price
  const b = child(hex(101), 2, [GROUPS[0].options[1], GROUPS[1].options[0]], { price: [{ currencyId: 'eur', gross: 95, net: 79.83, linked: true, apiAlias: 'price' }], active: true }); // Salbei/S, own price
  const c = child(hex(102), 3, [GROUPS[0].options[0], GROUPS[1].options[1]], { stock: 0 }); // Sand/M, gets deleted
  const { cs, payload } = await buildVariantsChangeSet(fakeReader([a, b, c]), { title: 't', reason: 'r', productId: PARENT,
    create: { axes: [{ group: 'Farbe', options: ['Rost'] }, { group: 'Material', options: ['Leinen'] }], defaults: { stock: 2, price: 70, listPrice: 90 } },
    update: [{ id: a.id, listPrice: 99 }, { id: b.id, price: null, stock: 9 }], remove: [c.id] });
  const settings = [[SAND, 'cs1'], [SALBEI, 'cs2'], [S, 'cs3'], [M, 'cs4']].map(([optionId, id], i) => ({ id, productId: PARENT, optionId, position: i + 1 }));
  const shop = fakeShop([parent, a, b, c], settings), before = shop.state();
  const res = await applyVariants(shop.sw, cs, payload, new Set(cs.items.map(i => i.id)));
  assert.deepEqual(res.results.map(r => r.ok), [true, true, true, true, true]);
  // Order: property → options → configurator (only missing ones) → variant
  const creates = shop.log.filter(l => l.startsWith('create'));
  assert.deepEqual(creates, ['create property-group', 'create property-group-option', 'create property-group-option', 'create product-configurator-setting', 'create product-configurator-setting', 'create product']);
  const nv = cs.items.find(i => i.field === 'create')!.afterRaw as NewVariant, created = shop.db.product.get(nv.id)!;
  assert.deepEqual(created.price, [{ currencyId: 'eur', gross: 70, net: 58.8235, linked: true, listPrice: { currencyId: 'eur', gross: 90, net: 75.6303, linked: true } }]);
  assert.deepEqual([created.stock, created.parentId, created.options.length], [2, PARENT, 2]);
  // Values: a gets its own price (inherited base 89 + list price), b inherits again and has stock 9
  const pa = shop.db.product.get(a.id)!, pb = shop.db.product.get(b.id)!;
  assert.deepEqual([pa.price[0].gross, pa.price[0].listPrice.gross, pa.price[0].net], [89, 99, 74.7899]);
  assert.deepEqual([pb.price, pb.stock], [null, 9]);
  // c deleted, option M with no remaining variant removed from the selection
  assert.equal(shop.db.product.has(c.id), false);
  assert.ok(shop.log.includes(`DELETE /product/${c.id}`) && shop.log.includes('DELETE /product-configurator-setting/cs4'));
  assert.equal(shop.db['product-configurator-setting'].size, 5, 'Sand, Salbei, S + Rost, Leinen');
  // Undo data exact: price null = inherit again, old price raw, snapshot of the deleted variant, configurator entry
  const ops = res.undo.map(u => `${u.op} ${u.entity}`);
  assert.deepEqual(ops, ['delete property-group', 'delete property-group-option', 'delete property-group-option', 'delete product-configurator-setting', 'delete product-configurator-setting', 'delete product', 'patch product', 'patch product', 'create product', 'create product-configurator-setting']);
  const patches = Object.fromEntries(res.undo.filter(u => u.op === 'patch').map(u => [u.id, u.data]));
  assert.deepEqual(patches[a.id], { price: null });
  assert.deepEqual(patches[b.id], { price: b.price, stock: 5 });
  const snap = res.undo.find(u => u.op === 'create' && u.entity === 'product')!;
  assert.equal(snap.id, c.id); assert.deepEqual((snap.data as { options: unknown[] }).options, [{ id: SAND }, { id: M }]);
  assert.deepEqual(res.undo.at(-1)!.data, { productId: PARENT, optionId: M, position: 4 });
  // Round trip: undo restores the fake's initial state
  const rb = await undoOps(shop.sw, res.undo);
  assert.ok(rb.every(r => r.ok), JSON.stringify(rb));
  assert.deepEqual(shop.state(), before);
});

test('applyVariants: an error creating a property fails all new variants, changes continue', async () => {
  const a = child(hex(100), 1, [GROUPS[1].options[0]]);
  const { cs, payload } = await buildVariantsChangeSet(fakeReader([a]), { title: 't', reason: 'r', productId: PARENT, create: { axes: [{ group: 'Material', options: ['Leinen', 'Wolle'] }] }, update: [{ id: a.id, stock: 7 }] });
  const shop = fakeShop([parent, a], []), create = shop.sw.create;
  shop.sw.create = async (e: string, d: SwEntity) => { if (e === 'property-group') throw new Error('Eigenschaft gesperrt'); return create(e, d); };
  const res = await applyVariants(shop.sw, cs, payload, new Set(cs.items.map(i => i.id)));
  const byId = Object.fromEntries(res.results.map(r => [r.itemId, r]));
  assert.ok(cs.items.filter(i => i.field === 'create').every(i => byId[i.id].ok === false && /gesperrt/.test(byId[i.id].error ?? '')));
  assert.equal(byId[`${a.id}:stock`].ok, true); assert.equal(shop.db.product.get(a.id)!.stock, 7);
  assert.deepEqual(res.undo.map(u => u.op), ['patch'], 'nothing half-created');
});

test('applyVariants: price change keeps the base price (unit price), a new variant does not invent one', async () => {
  const reg = { currencyId: 'eur', gross: 80, net: 67.2269, linked: false, apiAlias: 'price' };
  const b = child(hex(101), 2, [GROUPS[0].options[1], GROUPS[1].options[0]], { price: [{ currencyId: 'eur', gross: 95, net: 79.83, linked: true, regulationPrice: reg }] });
  const { cs, payload } = await buildVariantsChangeSet(fakeReader([b]), { title: 't', reason: 'r', productId: PARENT, update: [{ id: b.id, price: 90 }], create: { axes: [{ group: 'Farbe', options: ['Rost'] }], defaults: { stock: 1, price: 70 } } });
  const shop = fakeShop([parent, b], [[SAND, 'cs1'], [SALBEI, 'cs2'], [S, 'cs3']].map(([optionId, id], i) => ({ id, productId: PARENT, optionId, position: i + 1 })));
  const res = await applyVariants(shop.sw, cs, payload, new Set(cs.items.map(i => i.id)));
  assert.ok(res.results.every(r => r.ok), JSON.stringify(res.results));
  assert.deepEqual(shop.db.product.get(b.id)!.price[0].regulationPrice, { currencyId: 'eur', gross: 80, net: 67.2269, linked: false });
  assert.equal(shop.db.product.get(b.id)!.price[0].gross, 90);
  const created = shop.db.product.get((cs.items.find(i => i.field === 'create')!.afterRaw as NewVariant).id)!;
  assert.equal(created.price[0].regulationPrice, undefined);
});

test('list price of an inheriting variant: note that the price gets fixed', async () => {
  const a = child(hex(100), 1, [GROUPS[1].options[0]]);
  const { cs } = await buildVariantsChangeSet(fakeReader([a]), { title: 't', reason: 'r', productId: PARENT, update: [{ id: a.id, listPrice: 99 }] });
  assert.deepEqual(cs.items.find(i => i.field === 'listPrice')?.warn, ['Preis wird fixiert (bisher geerbt: 89,00 €)']);
  const both = await buildVariantsChangeSet(fakeReader([a]), { title: 't', reason: 'r', productId: PARENT, update: [{ id: a.id, price: 79, listPrice: 99 }] });
  assert.deepEqual(both.cs.items.find(i => i.field === 'listPrice')?.warn, []);
});

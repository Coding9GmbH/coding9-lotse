import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-stammdaten-'));
const { productFilter, planProduct, NewRegistry, cleanPrices, KIND_STAMMDATEN, snapshot } = await import('./stammdaten-plan');
const { buildProductDataChangeSet, stammdaten } = await import('./stammdaten');
const { applyItem, applyProductData, neededCreates, crossRecreate } = await import('./stammdaten-apply');
type Catalog = import('./stammdaten-plan').Catalog;
type ItemRaw = import('./stammdaten-plan').ItemRaw;
type UndoOp = import('@/lib/protocol').UndoOp;
type Reader = Parameters<typeof buildProductDataChangeSet>[0];
type Writer = Parameters<typeof applyItem>[0];

const H = (c: string) => c.repeat(32);
const seq = () => { let n = 0; return () => `new${++n}`; };
const COLOUR = { id: H('c'), name: 'Farbe' }, SAND = { id: H('1'), name: 'Sand', groupId: H('c'), group: COLOUR }, BLUE = { id: H('2'), name: 'Blau', groupId: H('c'), group: COLOUR };
const prod = (o: Record<string, unknown> = {}) => ({
  id: H('a'), name: 'Vase', productNumber: 'V-1', properties: [SAND], categories: [{ id: H('w'), name: 'Wohnen', translated: { name: 'Wohnen', breadcrumb: ['Start', 'Wohnen'] } }],
  tags: [], manufacturerId: H('m'), manufacturer: { id: H('m'), name: 'Haus Holm' }, deliveryTimeId: null, taxId: H('t'), tax: { id: H('t'), taxRate: 19, name: 'Standard' },
  price: [{ currencyId: 'eur', gross: 49, net: 41.18, linked: true }], visibilities: [{ id: H('v'), salesChannelId: H('s'), visibility: 30 }], crossSellings: [],
  minPurchase: 1, purchaseSteps: 1, maxPurchase: null, weight: null, shippingFree: false, releaseDate: null, ...o,
});
const catalog = (o: Partial<Catalog> = {}): Catalog => ({
  groups: [{ ...COLOUR, options: [SAND, BLUE] }], options: { [SAND.id]: SAND, [BLUE.id]: BLUE }, manufacturers: [{ id: H('m'), name: 'Haus Holm' }], tags: [{ id: H('g'), name: 'Sommer' }],
  deliveryTimes: [{ id: H('d'), name: '1-3 Tage' }], taxes: [{ id: H('t'), taxRate: 19, name: 'Standard' }, { id: H('r'), taxRate: 7, name: 'Ermäßigt' }],
  channels: [{ id: H('s'), name: 'Storefront' }, { id: H('h'), name: 'Headless' }], categories: { [H('f')]: { id: H('f'), name: 'Food', type: 'page' } },
  products: { [H('b')]: { id: H('b'), name: 'Becher' }, [H('p')]: { id: H('p'), name: 'Plaid' } }, streams: { [H('x')]: { id: H('x'), name: 'Neuheiten' } }, ...o,
});

test('productFilter: Filter → DAL-Kriterien, Hauptprodukte standardmäßig', () => {
  const r = productFilter({ categoryId: 'c1', tagId: 't1', taxRate: 7, productNumbers: ['A'], missing: ['deliveryTime', 'dimensions'], term: 'vase' });
  assert.deepEqual(r.filter[0], { type: 'equals', field: 'parentId', value: null });
  assert.ok(r.filter.some(f => f.field === 'categoriesRo.id' && f.value === 'c1'));
  assert.ok(r.filter.some(f => f.field === 'tags.id'));
  assert.ok(r.filter.some(f => f.field === 'tax.taxRate' && f.value === 7));
  assert.ok(r.filter.some(f => f.type === 'equalsAny' && f.field === 'productNumber'));
  assert.ok(r.filter.some(f => f.field === 'deliveryTimeId' && f.value === null));
  assert.ok(r.filter.some(f => f.type === 'multi' && f.operator === 'OR'));
  assert.equal(r.term, 'vase');
  assert.equal(productFilter({ includeVariants: true }).filter.length, 0);
  assert.throws(() => productFilter({ missing: ['foo' as never] }), /Unbekannter Filter/);
});

test('Eigenschaften: lesbar, Name ohne Groß/klein, neue Werte/Gruppen als „neu“ und nur einmal angelegt', () => {
  const reg = new NewRegistry(seq()), cat = catalog();
  const r = planProduct(prod(), { properties: { add: [{ group: 'farbe', option: 'blau' }, 'Farbe: Taupe', { group: 'Material', option: 'Leinen' }] } }, cat, reg, seq());
  assert.equal(r.items.length, 1);
  const it = r.items[0];
  assert.equal(it.before, 'Farbe: Sand · Material: –');
  assert.equal(it.after, 'Farbe: Blau, Sand, Taupe (neu) · Material: Leinen (neu)');
  assert.deepEqual(it.warn, ['legt „Farbe: Taupe“ neu an', 'legt „Material: Leinen“ neu an']);
  assert.deepEqual(reg.list.map(e => [e.entity, e.data.name, e.needs]), [['property-group-option', 'Taupe', undefined], ['property-group', 'Material', undefined], ['property-group-option', 'Leinen', 'new2']]);
  const raw = it.afterRaw as Extract<ItemRaw, { kind: 'assoc' }>;
  assert.deepEqual(raw.add, [BLUE.id, 'new1', 'new3']); assert.deepEqual(raw.uses.sort(), ['new1', 'new2', 'new3']);
  // zweites Produkt nutzt dieselben Neuanlagen
  const r2 = planProduct(prod({ id: H('b'), properties: [] }), { properties: { add: ['Farbe: taupe'] } }, cat, reg, seq());
  assert.deepEqual((r2.items[0].afterRaw as Extract<ItemRaw, { kind: 'assoc' }>).add, ['new1']);
  assert.equal(reg.list.length, 3);
});

test('Eigenschaften: Entfernen nur Vorhandenes, nichts zu tun = unverändert, Fehler werden übersprungen', () => {
  const reg = new NewRegistry(seq());
  const r = planProduct(prod(), { properties: { remove: [SAND.id], add: [H('9')] } }, catalog(), reg, seq());
  assert.equal(r.items[0].after, 'Farbe: –'); assert.match(r.skipped[0].reason, /nicht gefunden/);
  const u = planProduct(prod(), { properties: { add: ['Farbe: Sand'], remove: ['Farbe: Blau'] } }, catalog(), reg, seq());
  assert.equal(u.items.length, 0); assert.equal(u.unchanged, 1);
  assert.equal(reg.list.length, 0, 'Entfernen legt nie etwas an');
});

test('Kategorien, Tags, Hersteller, Lieferzeit: lesbare Vorher/Nachher-Werte, Warnungen', () => {
  const reg = new NewRegistry(seq());
  const r = planProduct(prod({ tags: [{ id: H('g'), name: 'Sommer' }] }), {
    categories: { add: [H('f'), H('z')], remove: [H('w')] }, tags: { add: ['Neu im Shop', 'sommer'], remove: ['SOMMER'] }, manufacturer: 'Lotse GmbH', deliveryTime: '1-3 tage',
  }, catalog(), reg, seq());
  const by = Object.fromEntries(r.items.map(i => [i.field, i]));
  assert.equal(by.categories.before, 'Wohnen'); assert.equal(by.categories.after, 'Food');
  assert.match(r.skipped[0].reason, /Kategorie .* nicht gefunden/);
  assert.equal(by.tags.after, 'Neu im Shop (neu)'); assert.deepEqual((by.tags.afterRaw as Extract<ItemRaw, { kind: 'assoc' }>).remove, [H('g')]);
  assert.equal(by.manufacturer.before, 'Haus Holm'); assert.equal(by.manufacturer.after, 'Lotse GmbH (neu)');
  assert.deepEqual((by.manufacturer.afterRaw as Extract<ItemRaw, { kind: 'scalar' }>).data, { manufacturerId: 'new1' });
  assert.equal(by.deliveryTime.before, '–'); assert.equal(by.deliveryTime.after, '1-3 Tage');
  const r2 = planProduct(prod(), { categories: { remove: [H('w')] }, manufacturer: 'haus holm', deliveryTime: 'Morgen' }, catalog(), new NewRegistry(seq()), seq());
  assert.deepEqual(r2.items[0].warn, ['Produkt ist danach in keiner Kategorie']);
  assert.equal(r2.unchanged, 1); assert.match(r2.skipped[0].reason, /Lieferzeit „Morgen“ nicht gefunden/);
});

test('Einfache Felder: Validierung, Einheiten, unverändert', () => {
  const r = planProduct(prod({ weight: 0.5 }), { weight: 0.8, width: 120, shippingFree: true, minPurchase: 2, maxPurchase: 10, releaseDate: '2026-01-15', markAsTopseller: false }, catalog(), new NewRegistry(seq()), seq());
  const by = Object.fromEntries(r.items.map(i => [i.field, i]));
  assert.equal(by.weight.before, '0,5 kg'); assert.equal(by.weight.after, '0,8 kg'); assert.equal(by.width.after, '120 mm');
  assert.equal(by.shippingFree.after, 'ja'); assert.equal(by.maxPurchase.before, 'unbegrenzt'); assert.equal(by.releaseDate.after, '15.01.2026');
  assert.deepEqual((by.releaseDate.afterRaw as Extract<ItemRaw, { kind: 'scalar' }>).data, { releaseDate: '2026-01-15T00:00:00.000+00:00' });
  assert.equal(r.unchanged, 1, 'markAsTopseller bleibt false');
  const bad = planProduct(prod(), { weight: -1, minPurchase: 0, maxPurchase: 3, releaseDate: '15.01.2026' }, catalog(), new NewRegistry(seq()), seq());
  assert.equal(bad.items.length, 1, 'nur maxPurchase gültig'); assert.equal(bad.skipped.length, 3);
  const low = planProduct(prod(), { minPurchase: 5, maxPurchase: 2 }, catalog(), new NewRegistry(seq()), seq());
  assert.ok(low.skipped.some(s => /Maximalabnahme kleiner/.test(s.reason)));
});

test('Steuersatz: Brutto bleibt, Netto neu in der Anzeige; unbekannter Satz wird übersprungen', () => {
  const r = planProduct(prod(), { taxRate: 7 }, catalog(), new NewRegistry(seq()), seq());
  assert.equal(r.items[0].before, '19 % (Standard)');
  assert.equal(r.items[0].after, '7 % (Ermäßigt) · brutto bleibt 49,00 €, netto 41,18 € → 45,79 €');
  assert.deepEqual(r.items[0].afterRaw, { kind: 'tax', taxId: H('r'), taxRate: 7, uses: [] });
  assert.match(planProduct(prod(), { taxRate: 10 }, catalog(), new NewRegistry(seq()), seq()).skipped[0].reason, /Kein Steuersatz 10 %/);
});

test('Sichtbarkeit: hinzufügen/ändern/entfernen, Warnung ohne Kanal', () => {
  const r = planProduct(prod(), { visibility: { add: [{ salesChannel: 'headless', visibility: 'search' }] } }, catalog(), new NewRegistry(seq()), seq());
  assert.equal(r.items[0].before, 'Storefront (überall)'); assert.equal(r.items[0].after, 'Storefront (überall), Headless (nur Suche)');
  assert.deepEqual((r.items[0].afterRaw as Extract<ItemRaw, { kind: 'visibility' }>).add, [{ salesChannelId: H('h'), visibility: 20 }]);
  const off = planProduct(prod(), { visibility: { remove: ['Storefront'] } }, catalog(), new NewRegistry(seq()), seq());
  assert.deepEqual(off.items[0].warn, ['Produkt ist danach in keinem Verkaufskanal sichtbar']);
  assert.deepEqual((off.items[0].afterRaw as Extract<ItemRaw, { kind: 'visibility' }>).remove, [H('s')]);
});

test('Cross-Selling: anlegen ohne eigenes Produkt, ändern per Name, löschen, Fehler', () => {
  const cs = { id: H('k'), name: 'Passend dazu', type: 'productList', active: true, position: 1, assignedProducts: [{ id: 'a1', productId: H('b'), position: 0 }, { id: 'a2', productId: H('p'), position: 1 }] };
  const r = planProduct(prod({ crossSellings: [cs] }), { crossSellings: [
    { action: 'create', name: 'Ähnlich', productIds: [H('a'), H('p')] },
    { action: 'update', match: 'passend DAZU', name: 'Dazu passt', productIds: [H('p'), H('b')] },
    { action: 'create', name: 'Stream', type: 'productStream', productStreamId: H('x') },
    { action: 'create', name: 'Passend dazu', productIds: [H('b')] },
    { action: 'delete', match: 'gibt es nicht' },
  ] }, catalog(), new NewRegistry(seq()), seq());
  assert.equal(r.items.length, 3); assert.equal(r.skipped.length, 2);
  const [c1, u, st] = r.items;
  assert.equal(c1.after, '„Ähnlich“ · Produktliste · 1 Produkt: Plaid');
  assert.deepEqual((c1.afterRaw as { productIds: string[] }).productIds, [H('p')]);
  assert.equal((c1.afterRaw as { data: { position: number } }).data.position, 2);
  assert.equal(u.before, '„Passend dazu“ · Produktliste · 2 Produkte: Becher, Plaid'); assert.equal(u.after, '„Dazu passt“ · Produktliste · 2 Produkte: Plaid, Becher');
  assert.deepEqual(u.afterRaw, { kind: 'cross', action: 'update', id: H('k'), set: { name: 'Dazu passt' }, productIds: [H('p'), H('b')], uses: [] });
  assert.equal(st.after, '„Stream“ · Produktstream: Neuheiten');
  const d = planProduct(prod({ crossSellings: [cs] }), { crossSellings: [{ action: 'delete', id: H('k') }, { action: 'update', match: 'Passend dazu', removeProductIds: [H('b'), H('p')] }] }, catalog(), new NewRegistry(seq()), seq());
  assert.equal(d.items[0].after, 'gelöscht'); assert.match(d.skipped[0].reason, /wäre leer/);
});

test('cleanPrices: Netto aus Brutto neu, Streichpreis mit, Lesefelder weg', () => {
  const p = [{ currencyId: 'eur', gross: 107, net: 89.92, linked: true, percentage: { net: 1, gross: 1 }, extensions: [], listPrice: { currencyId: 'eur', gross: 214, net: 179.83, linked: true } }];
  assert.deepEqual(cleanPrices(p as never, 7), [{ currencyId: 'eur', gross: 107, net: 100, linked: true, listPrice: { currencyId: 'eur', gross: 214, net: 200, linked: true } }]);
  assert.deepEqual(cleanPrices(p as never)![0].net, 89.92);
  assert.equal(cleanPrices(null), null);
});

// ---- Builder mit Fake-Reader ----
const fakeReader = (products: Record<string, unknown>[], extra: Record<string, unknown[]> = {}, total?: number): Reader => ({
  base: 'http://shop.test',
  search: async (entity: string, c: { ids?: string[]; filter?: { field?: string; value?: unknown }[] } = {}) => {
    if (entity === 'product') {
      if (c.ids) return { data: products.filter(p => c.ids!.includes(p.id as string)) };
      const nums = c.filter?.find(f => f.field === 'productNumber')?.value as string[] | undefined;
      const data = nums ? products.filter(p => nums.includes(p.productNumber as string)) : products;
      return { data, total: total ?? data.length };
    }
    const all = (extra[entity] ?? []) as { id: string }[];
    return { data: c.ids ? all.filter(x => c.ids!.includes(x.id)) : all };
  },
  get: async () => null, salesChannels: async () => [], req: async () => null,
} as unknown as Reader);

test('Builder: productIds + Filter, doppelte Felder übersprungen, Neuanlagen nur wenn genutzt', async () => {
  const ro = fakeReader([prod(), prod({ id: H('b'), productNumber: 'B-1', name: 'Becher', properties: [] })], { 'property-group': [{ ...COLOUR }], 'property-group-option': [SAND, BLUE], tag: [] });
  const { cs, payload } = await buildProductDataChangeSet(ro, { title: 'T', reason: 'R', changes: [
    { productIds: [H('a')], properties: { add: ['Farbe: Taupe'] }, tags: { add: ['Neu'] } },
    { filter: { productNumbers: ['B-1', 'V-1'] }, tags: { add: ['Neu'] } },
  ] }, seq());
  assert.equal(cs.kind, KIND_STAMMDATEN); assert.deepEqual(cs.noun, { one: 'Produkt', many: 'Produkte' });
  assert.deepEqual(cs.items.map(i => i.id), [`${H('a')}:properties`, `${H('a')}:tags`, `${H('b')}:tags`]);
  assert.match(cs.skipped[0].reason, /mehrfach angegeben/);
  assert.deepEqual(payload.creates.map(c => c.data.name), ['Taupe', 'Neu']);
  // Auswahl ohne Eigenschaften → nur Tag wird angelegt; neue Option zieht ihre neue Gruppe mit
  assert.deepEqual(neededCreates(cs.items.filter(i => i.field === 'tags'), payload.creates).map(c => c.entity), ['tag']);
  const withGroup = [{ id: 'g', entity: 'property-group' as const, data: {}, label: '' }, { id: 'o', entity: 'property-group-option' as const, data: {}, label: '', needs: 'g' }];
  assert.deepEqual(neededCreates([{ afterRaw: { uses: ['o'] } } as never], withGroup).map(c => c.id), ['g', 'o']);
});

test('Builder: zu viele Treffer, ohne Ziel und ohne Änderung → Fehler', async () => {
  await assert.rejects(buildProductDataChangeSet(fakeReader([prod()], {}, 999), { title: 'T', reason: 'R', changes: [{ filter: {}, shippingFree: true }] }), /trifft 999 Produkte/);
  await assert.rejects(buildProductDataChangeSet(fakeReader([prod()]), { title: 'T', reason: 'R', changes: [{ shippingFree: true }] }), /productIds oder filter/);
  await assert.rejects(buildProductDataChangeSet(fakeReader([prod()]), { title: 'T', reason: 'R', changes: [{ productIds: [H('a')], shippingFree: false }] }), /Keine Änderung nötig.*\(1 unverändert/);
});

// ---- Executor mit Fake-Writer: exakte Rückgängig-Schritte ----
const fakeWriter = (kids: Record<string, unknown>[] = []) => {
  const calls: unknown[][] = [], pages: number[] = [];
  const w = { calls, pages, update: async (...a: unknown[]) => { calls.push(['update', ...a]); }, create: async (...a: unknown[]) => { calls.push(['create', ...a]); }, req: async (...a: unknown[]) => { calls.push(['req', ...a]); },
    search: async (_e: string, c: { page?: number; limit?: number }) => { const l = c.limit ?? 500, p = c.page ?? 1; pages.push(p); return { data: kids.slice((p - 1) * l, p * l) }; } };
  return w as unknown as Writer & { calls: unknown[][]; pages: number[] };
};

test('applyItem: Zuordnungen nur Differenz, Undo per DELETE-req bzw. Wieder-Hinzufügen', async () => {
  const w = fakeWriter(), undo: UndoOp[] = [];
  await applyItem(w, prod(), { kind: 'assoc', assoc: 'properties', add: [SAND.id, BLUE.id], remove: [SAND.id, H('9')], uses: [] }, undo);
  assert.deepEqual(w.calls, [['update', 'product', H('a'), { properties: [{ id: BLUE.id }] }], ['req', 'DELETE', `/product/${H('a')}/properties/${SAND.id}`]]);
  assert.deepEqual(undo, [
    { op: 'req', entity: 'product', id: H('a'), method: 'DELETE', path: `/product/${H('a')}/properties/${BLUE.id}` },
    { op: 'patch', entity: 'product', id: H('a'), data: { properties: [{ id: SAND.id }] } },
  ]);
});

test('applyItem: Felder, Sichtbarkeit und Steuer (inkl. Variante) mit Vorher-Werten', async () => {
  const w = fakeWriter([{ id: 'kid', taxId: null, price: [{ currencyId: 'eur', gross: 10.7, net: 9, linked: true }], prices: [] }]), undo: UndoOp[] = [];
  await applyItem(w, prod({ weight: 0.5 }), { kind: 'scalar', data: { weight: 1, manufacturerId: null }, uses: [] }, undo);
  assert.deepEqual(undo.pop(), { op: 'patch', entity: 'product', id: H('a'), data: { weight: 0.5, manufacturerId: H('m') } });
  await applyItem(w, prod(), { kind: 'visibility', add: [{ salesChannelId: H('s'), visibility: 10 }, { salesChannelId: H('h'), visibility: 30 }], remove: [H('s')], uses: [] }, undo);
  assert.deepEqual(undo[0], { op: 'patch', entity: 'product-visibility', id: H('v'), data: { visibility: 30 } });
  assert.equal(undo[1].op, 'delete'); assert.equal(undo[1].entity, 'product-visibility');
  assert.deepEqual(undo[2], { op: 'create', entity: 'product-visibility', id: H('v'), data: { productId: H('a'), salesChannelId: H('s'), visibility: 30 } });
  undo.length = 0; w.calls.length = 0;
  await applyItem(w, prod({ prices: [{ id: 'pp', price: [{ currencyId: 'eur', gross: 21.4, net: 18, linked: true }] }] }), { kind: 'tax', taxId: H('r'), taxRate: 7, uses: [] }, undo);
  assert.deepEqual(w.calls[0], ['update', 'product', H('a'), { taxId: H('r'), price: [{ currencyId: 'eur', gross: 49, net: 45.7944, linked: true }], prices: [{ id: 'pp', price: [{ currencyId: 'eur', gross: 21.4, net: 20, linked: true }] }] }]);
  assert.deepEqual(undo[0], { op: 'patch', entity: 'product', id: H('a'), data: { taxId: H('t'), price: [{ currencyId: 'eur', gross: 49, net: 41.18, linked: true }], prices: [{ id: 'pp', price: [{ currencyId: 'eur', gross: 21.4, net: 18, linked: true }] }] } });
  assert.deepEqual(w.calls[1], ['update', 'product', 'kid', { price: [{ currencyId: 'eur', gross: 10.7, net: 10, linked: true }] }]);
  assert.deepEqual(undo[1], { op: 'patch', entity: 'product', id: 'kid', data: { price: [{ currencyId: 'eur', gross: 10.7, net: 9, linked: true }] } });
});

test('applyItem: Cross-Selling ändern/löschen – Zuordnungen, Positionen, Wiederanlage mit gleichen IDs', async () => {
  const cs = { id: 'cs1', name: 'Alt', type: 'productList', active: true, position: 1, limit: 24, sortBy: 'name', sortDirection: 'ASC', productStreamId: null, translations: [{ languageId: 'de', name: 'Alt' }],
    assignedProducts: [{ id: 'a1', productId: 'pB', position: 0 }, { id: 'a2', productId: 'pP', position: 1 }] };
  const w = fakeWriter(), undo: UndoOp[] = [];
  await applyItem(w, prod({ crossSellings: [cs] }), { kind: 'cross', action: 'update', id: 'cs1', set: { name: 'Neu' }, productIds: ['pP', 'pX'], uses: [] }, undo);
  assert.deepEqual(w.calls[0], ['req', 'DELETE', '/product-cross-selling-assigned-products/a1']);
  const upd = w.calls[1] as [string, string, string, { name: string; assignedProducts: { id: string; productId?: string; position: number }[] }];
  assert.equal(upd[3].name, 'Neu');
  assert.deepEqual(upd[3].assignedProducts[0], { id: 'a2', position: 0 });
  assert.equal(upd[3].assignedProducts[1].productId, 'pX');
  assert.deepEqual(undo[0], { op: 'create', entity: 'product-cross-selling-assigned-products', id: 'a1', data: { crossSellingId: 'cs1', productId: 'pB', position: 0 } });
  assert.deepEqual(undo[1], { op: 'patch', entity: 'product-cross-selling', id: 'cs1', data: { name: 'Alt', assignedProducts: [{ id: 'a2', position: 1 }] } });
  assert.deepEqual(undo[2], { op: 'delete', entity: 'product-cross-selling-assigned-products', id: upd[3].assignedProducts[1].id });
  undo.length = 0;
  await applyItem(w, prod({ crossSellings: [cs] }), { kind: 'cross', action: 'delete', id: 'cs1', uses: [] }, undo);
  assert.deepEqual(undo, [{ op: 'create', entity: 'product-cross-selling', id: 'cs1', data: crossRecreate(H('a'), cs) }]);
  assert.deepEqual(crossRecreate(H('a'), cs).translations, [{ languageId: 'de', name: 'Alt' }]);
  assert.deepEqual(crossRecreate(H('a'), cs).assignedProducts, [{ id: 'a1', productId: 'pB', position: 0 }, { id: 'a2', productId: 'pP', position: 1 }]);
  await assert.rejects(applyItem(w, prod(), { kind: 'cross', action: 'delete', id: 'weg', uses: [] }, undo), /nicht mehr vorhanden/);
});

test('Datenschutz: Stammdaten-Beziehungen erlaubt, Kunden-/Bestelldaten bleiben gesperrt', async () => {
  const { createGuard } = await import('../policy');
  const { PRODUCT_ASSOC } = await import('./stammdaten');
  const g = createGuard();
  assert.doesNotThrow(() => g.checkSearch('product', { associations: { ...PRODUCT_ASSOC, crossSellings: { associations: { assignedProducts: { associations: { product: {} } } } } } }));
  assert.doesNotThrow(() => g.checkSearch('property-group', { associations: { options: {} } }));
  assert.throws(() => g.checkSearch('product', { associations: { crossSellings: { associations: { assignedProducts: { associations: { product: { associations: { orderLineItems: {} } } } } } } } }), /ZUGRIFF VERWEIGERT/);
  assert.throws(() => g.checkSearch('product', { associations: { visibilities: { associations: { salesChannel: { associations: { customers: {} } } } } } }), /ZUGRIFF VERWEIGERT/);
});

test('applyItem: Steuerwechsel rechnet ALLE Varianten mit eigenem Preis um (seitenweise, nicht nur die ersten 500)', async () => {
  const kids = Array.from({ length: 501 }, (_, i) => ({ id: `kid${i}`, taxId: null, price: [{ currencyId: 'eur', gross: 10.7, net: 9, linked: true }] }));
  const w = fakeWriter(kids), undo: UndoOp[] = [];
  await applyItem(w, prod(), { kind: 'tax', taxId: H('r'), taxRate: 7, uses: [] }, undo);
  assert.deepEqual(w.pages, [1, 2]);
  assert.equal(w.calls.filter(c => c[0] === 'update').length, 502, 'Hauptprodukt + 501 Varianten');
  assert.equal(undo.length, 502);
  assert.deepEqual(undo[501], { op: 'patch', entity: 'product', id: 'kid500', data: { price: [{ currencyId: 'eur', gross: 10.7, net: 9, linked: true }] } });
});

// ---- Listen-Werkzeuge: offset wird auf die Shopware-Seite gerundet und so zurückgemeldet ----
const pagedReader = (n: number) => {
  const rows = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, productNumber: `P-${String(i).padStart(3, '0')}`, name: `Produkt ${i}` }));
  const searches: { page?: number; limit?: number }[] = [];
  const ro = { base: 'http://shop.test', searches, search: async (_e: string, c: { page?: number; limit?: number }) => { searches.push(c); const l = c.limit ?? 25, p = c.page ?? 1; return { data: rows.slice((p - 1) * l, p * l), total: rows.length }; }, salesChannels: async () => [] };
  return ro;
};
const run = async (ro: ReturnType<typeof pagedReader>, name: string, args: Record<string, unknown>) => {
  const t = stammdaten.tools({ sw: ro } as never).find(x => x.name === name)!;
  const r = await t.handler(args as never, {});
  return JSON.parse((r.content[0] as { text: string }).text);
};

test('find_products_by_data/list_*: offset 50 bei limit 30 → Seite 2, Antwort meldet offset 30 + note + nextOffset', async () => {
  const ro = pagedReader(120);
  const r = await run(ro, 'find_products_by_data', { limit: 30, offset: 50 });
  assert.equal(ro.searches[0].page, 2); assert.equal(ro.searches[0].limit, 30);
  assert.equal(r.offset, 30); assert.match(r.note, /offset auf 30 gerundet/); assert.equal(r.returned, 30); assert.equal(r.total, 120); assert.equal(r.nextOffset, 60);
  assert.equal(r.products[0].id, 'p30');
  const last = await run(ro, 'find_products_by_data', { limit: 30, offset: 90 });
  assert.equal(last.note, undefined); assert.equal(last.nextOffset, null); assert.equal(last.offset, 90);
  // Erhöhung des Limits nach der ersten Seite (offset 50, limit 100) → wieder Seite 1, ehrlich gemeldet
  const m = await run(ro, 'list_manufacturers', { limit: 100, offset: 50 });
  assert.equal(m.offset, 0); assert.match(m.note, /gerundet/); assert.equal(m.nextOffset, 100);
  for (const name of ['list_tags', 'list_property_groups']) { const x = await run(ro, name, { limit: 10, offset: 10 }); assert.equal(x.offset, 10); assert.equal(x.note, undefined); assert.equal(x.nextOffset, 20); }
  const o = await run(ro, 'list_property_groups', { groupId: H('c'), limit: 10, offset: 15 });
  assert.equal(o.offset, 10); assert.equal(o.nextOffset, 20);
});

// ---- Executor applyProductData: Neuanlagen, Produkt-Gruppen, Teilfehler ----
const applyWriter = (o: { get?: () => Promise<unknown>; failCreate?: (n: number) => boolean; failUpdate?: (data: Record<string, unknown>) => boolean } = {}) => {
  const calls: unknown[][] = []; let creates = 0;
  const w = {
    calls,
    get: o.get ?? (async () => prod({ properties: [], tags: [] })),
    create: async (...a: unknown[]) => { calls.push(['create', ...a]); if (o.failCreate?.(++creates)) throw new Error('boom'); },
    update: async (e: string, id: string, data: Record<string, unknown>) => { calls.push(['update', e, id, data]); if (o.failUpdate?.(data)) throw new Error('kaputt'); },
    req: async (...a: unknown[]) => { calls.push(['req', ...a]); }, search: async () => ({ data: [] }),
  };
  return w as unknown as Writer & { calls: unknown[][] };
};
const buildSet = () => buildProductDataChangeSet(fakeReader([prod({ properties: [], tags: [] })], { 'property-group': [{ ...COLOUR }], 'property-group-option': [SAND, BLUE], tag: [] }),
  { title: 'T', reason: 'R', changes: [{ productIds: [H('a')], properties: { add: ['Material: Leinen'] }, tags: { add: ['Neu'] } }] }, seq());

test('applyProductData: Neuanlagen in Reihenfolge Gruppe → Wert → Tag; Fehler bei der Anlage bricht ab, bereits Angelegtes im undo', async () => {
  const { cs, payload } = await buildSet();
  assert.deepEqual(payload.creates.map(c => [c.entity, c.data.name, c.needs]), [['property-group', 'Material', undefined], ['property-group-option', 'Leinen', 'new1'], ['tag', 'Neu', undefined]]);
  const sel = new Set(cs.items.map(i => i.id));
  const a = await applyProductData(applyWriter({ failCreate: n => n === 1 }), cs, payload, sel);
  assert.deepEqual(a, { results: [], undo: [], error: 'Eigenschaft „Material“ konnte nicht angelegt werden: boom' });
  const b = await applyProductData(applyWriter({ failCreate: n => n === 2 }), cs, payload, sel);
  assert.deepEqual(b.undo, [{ op: 'delete', entity: 'property-group', id: 'new1' }]); assert.match(b.error!, /Material: Leinen konnte nicht angelegt werden/);
  // nur Tags ausgewählt → nur der Tag wird angelegt
  const w = applyWriter(), c = await applyProductData(w, cs, payload, new Set([`${H('a')}:tags`]));
  assert.deepEqual(w.calls.filter(x => x[0] === 'create').map(x => x[1]), ['tag']);
  assert.deepEqual(c.results, [{ itemId: `${H('a')}:tags`, ok: true }]);
  assert.deepEqual(c.undo, [{ op: 'delete', entity: 'tag', id: 'new3' }, { op: 'req', entity: 'product', id: H('a'), method: 'DELETE', path: `/product/${H('a')}/tags/new3` }]);
});

test('applyProductData: Produkt verschwunden → alle Items des Produkts fehlgeschlagen; Teilfehler lässt die Undo-Schritte der vorigen Items stehen', async () => {
  const { cs, payload } = await buildSet(), sel = new Set(cs.items.map(i => i.id));
  const gone = await applyProductData(applyWriter({ get: async () => null }), cs, payload, sel);
  assert.deepEqual(gone.results, cs.items.map(i => ({ itemId: i.id, ok: false, error: 'Produkt nicht mehr vorhanden' })));
  assert.deepEqual(gone.undo.map(u => [u.op, u.entity]), [['delete', 'property-group'], ['delete', 'property-group-option'], ['delete', 'tag']], 'Neuanlagen bleiben rückgängig machbar');
  const w = applyWriter({ failUpdate: d => 'tags' in d }), part = await applyProductData(w, cs, payload, sel);
  assert.deepEqual(part.results, [{ itemId: `${H('a')}:properties`, ok: true }, { itemId: `${H('a')}:tags`, ok: false, error: 'kaputt' }]);
  assert.deepEqual(part.undo.slice(3), [{ op: 'req', entity: 'product', id: H('a'), method: 'DELETE', path: `/product/${H('a')}/properties/new2` }]);
  assert.equal(part.error, undefined);
});

test('applyProductData: mehrere Produkte parallel, je Produkt frischer Stand', async () => {
  const ro = fakeReader([prod({ tags: [] }), prod({ id: H('b'), productNumber: 'B-1', tags: [] })], { tag: [{ id: H('g'), name: 'Sommer' }] });
  const { cs, payload } = await buildProductDataChangeSet(ro, { title: 'T', reason: 'R', changes: [{ productIds: [H('a'), H('b')], tags: { add: ['Sommer'] } }] }, seq());
  const gets: string[] = [];
  const w = applyWriter();
  (w as unknown as { get: (e: string, id: string) => Promise<unknown> }).get = async (_e, id) => { gets.push(id); return prod({ id, tags: [] }); };
  const r = await applyProductData(w, cs, payload, new Set(cs.items.map(i => i.id)));
  assert.deepEqual(gets.sort(), [H('a'), H('b')]); assert.deepEqual(payload.creates, []);
  assert.deepEqual(r.results.map(x => x.ok), [true, true]); assert.equal(r.undo.length, 2);
});

test('Stale-Write-Guard: Eigenschaften inzwischen geändert → Item fehlgeschlagen und nicht geschrieben, übrige Items des Produkts laufen weiter; Altbestand ohne beforeRaw schreibt', async () => {
  const { cs, payload } = await buildSet(), sel = new Set(cs.items.map(i => i.id));
  assert.deepEqual(cs.items.map(i => [i.field, i.beforeRaw]), [['properties', []], ['tags', []]], 'Builder merkt die Zuordnungen beim Vorschlag');
  // Admin hat dem Produkt inzwischen „Sand“ zugeordnet
  const w = applyWriter({ get: async () => prod({ properties: [SAND], tags: [] }) });
  const r = await applyProductData(w, cs, payload, sel);
  assert.deepEqual(r.results, [{ itemId: `${H('a')}:properties`, ok: false, error: 'Eigenschaften: inzwischen geändert, bitte neu vorschlagen' }, { itemId: `${H('a')}:tags`, ok: true }]);
  assert.ok(!w.calls.some(c => c[0] === 'update' && 'properties' in (c[3] as object)), 'Eigenschaften nicht geschrieben');
  assert.ok(w.calls.some(c => c[0] === 'update' && 'tags' in (c[3] as object)), 'Tags geschrieben');
  // Altbestand (ohne beforeRaw): keine Prüfung, Verhalten wie bisher
  const old = { ...cs, items: cs.items.map(i => ({ ...i, beforeRaw: undefined })) };
  assert.deepEqual((await applyProductData(applyWriter({ get: async () => prod({ properties: [SAND], tags: [] }) }), old, payload, sel)).results.map(x => x.ok), [true, true]);
});

test('snapshot: Ausschnitt je Item-Art (Zuordnungen sortiert, Felder, Steuer, Sichtbarkeit, Cross-Selling), Anlegen ohne Snapshot', () => {
  const p = prod({ crossSellings: [{ id: H('x'), name: 'Zubehör', type: 'productList', active: true, position: 1, limit: 24, sortBy: 'name', sortDirection: 'ASC', assignedProducts: [{ id: 'a2', productId: H('p'), position: 1 }, { id: 'a1', productId: H('b'), position: 0 }] }] });
  assert.deepEqual(snapshot(p, { kind: 'assoc', assoc: 'properties', add: [], remove: [], uses: [] }), [SAND.id]);
  assert.deepEqual(snapshot(p, { kind: 'scalar', data: { weight: 2, manufacturerId: null }, uses: [] }), { weight: null, manufacturerId: H('m') });
  assert.equal(snapshot(p, { kind: 'tax', taxId: H('r'), taxRate: 7, uses: [] }), H('t'));
  assert.deepEqual(snapshot(p, { kind: 'visibility', add: [], remove: [], uses: [] }), [`${H('s')}:30`]);
  assert.deepEqual(snapshot(p, { kind: 'cross', action: 'update', id: H('x'), set: {}, productIds: null, uses: [] }), { name: 'Zubehör', type: 'productList', active: true, position: 1, limit: 24, sortBy: 'name', sortDirection: 'ASC', productStreamId: null, products: [H('b'), H('p')] });
  assert.equal(snapshot(p, { kind: 'cross', action: 'delete', id: H('y'), uses: [] }), null, 'nicht mehr vorhanden');
  assert.equal(snapshot(p, { kind: 'cross', action: 'create', id: H('n'), data: {}, productIds: [], uses: [] }), undefined);
});

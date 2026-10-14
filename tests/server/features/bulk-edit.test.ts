import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ShopReader, Shopware, SwEntity } from '../../../src/server/shopware';
import { applyBulk, bulkChangeSet, bulkCriteria, bulkStale, cleanPrices, describeChange, planProduct, planWrite, resolveProducts, validateChange, BULK_SCAN, CHUNK, SAMPLE, type BulkPayload } from '../../../src/server/features/bulk-edit';

const price = (gross: number, list?: number) => [{ currencyId: 'eur', gross, net: gross / 1.19, linked: true, percentage: null, apiAlias: 'price', ...(list != null ? { listPrice: { currencyId: 'eur', gross: list, net: list / 1.19, linked: true, apiAlias: 'price' } } : { listPrice: null }) }];
const prod = (id: string, gross: number | null, extra: SwEntity = {}): SwEntity => ({ id, productNumber: `P-${id}`, name: `Produkt ${id}`, price: gross == null ? null : price(gross), stock: 10, active: true, tax: { taxRate: 19 }, ...extra });

test('validateChange: klare Fehler bei ungültigen Regeln', () => {
  assert.throws(() => validateChange({}), /leer/);
  assert.throws(() => validateChange({ price: { percent: -10, add: 1 } }), /genau eine/);
  assert.throws(() => validateChange({ price: { percent: -100 } }), /größer als −100/);
  assert.throws(() => validateChange({ price: { percent: 5, round: '99' } }), /round/);
  assert.throws(() => validateChange({ stock: { set: -1 } }), /Bestand/);
  assert.throws(() => validateChange({ name: 'x' } as never), /Nicht erlaubte Felder: name/);
  assert.doesNotThrow(() => validateChange({ price: { percent: -10, round: '.99' }, listPrice: 'currentPrice', stock: { add: -3 }, active: false }));
});

test('describeChange + bulkCriteria', () => {
  assert.equal(describeChange({ price: { percent: -10, round: '.99' }, listPrice: 'currentPrice', stock: { add: -3 }, deliveryTime: 'd1' }, '1-3 Tage'),
    'Preis −10 %, gerundet auf .99 · Streichpreis = bisheriger Preis · Bestand −3 · Lieferzeit = 1-3 Tage');
  const c = bulkCriteria({ categoryId: 'c', term: 'vase', active: true, maxStock: 0, properties: ['o1'] }, 'm1');
  assert.deepEqual(c.filter, [{ type: 'equals', field: 'parentId', value: null }, { type: 'equals', field: 'categoriesRo.id', value: 'c' }, { type: 'equals', field: 'manufacturerId', value: 'm1' },
    { type: 'equalsAny', field: 'properties.id', value: ['o1'] }, { type: 'equals', field: 'active', value: true }, { type: 'range', field: 'stock', parameters: { lte: 0 } }]);
  assert.equal(c.term, 'vase');
  // mit Varianten: Status/Bestand prüft der Server auf wirksamen Werten
  assert.equal(bulkCriteria({ active: true, includeVariants: true }).filter.length, 1);
});

test('planProduct: Preisregel, Warnungen, Streichpreis = bisheriger Preis', () => {
  const r = planProduct(prod('a', 20, { purchasePrices: price(17) }), undefined, { price: { percent: -20, round: '.99' }, listPrice: 'currentPrice' }, false);
  assert.deepEqual(r.plan, { id: 'a', group: 'warn', price: { gross: 15.99, list: 20 }, prev: { gross: 20, list: null } });
  assert.deepEqual(r.warn, ['unter Einkaufspreis (17,00 €)']);
  assert.deepEqual([r.before, r.after], [['20,00 €', '–'], ['15,99 €', '20,00 €']]);
  const big = planProduct(prod('b', 10), undefined, { price: { add: 5 } }, false);
  assert.deepEqual(big.warn, ['Preisänderung +50 %']);
  assert.match(planProduct(prod('c', 0.5), undefined, { price: { set: 0.004 } }, false).warn.join(), /unter 0,01 €/);
  assert.equal(planProduct(prod('d', 1), undefined, { price: { add: -5 } }, false).skip, 'Preis würde negativ (-4,00 €)');
  assert.equal(planProduct(prod('e', 9.99), undefined, { price: { set: 9.99 } }, false).plan, null); // unverändert
});

test('planProduct: Varianten erben, folgen dem mitgeänderten Hauptprodukt, sonst eigener Preis', () => {
  const parent = prod('p', 50), v = prod('v', null, { parentId: 'p', active: null, name: null });
  assert.equal(planProduct(v, parent, { price: { percent: 10 } }, true).plan, null);
  const own = planProduct(v, parent, { price: { percent: 10 }, active: false }, false);
  assert.deepEqual(own.plan, { id: 'v', group: 'ok', price: { gross: 55 }, active: false, prev: { gross: 50, active: true } });
  assert.equal(own.before[0], '50,00 € (geerbt)');
  assert.equal(own.label, 'Produkt p, Variante (P-v)');
  const stock = planProduct(prod('s', 5, { stock: 2 }), undefined, { stock: { add: -5 } }, false);
  assert.deepEqual([stock.plan?.stockAdd, stock.plan?.stock, stock.after, stock.warn], [-5, undefined, ['0'], ['Bestand wäre negativ → 0', 'Bestand auf 0']]);
  assert.equal(planProduct(prod('s', 5, { stock: 2 }), undefined, { stock: { set: 7 } }, false).plan?.stock, 7);
  // nur Streichpreis bei geerbtem Preis → Preis wird fixiert
  assert.deepEqual(planProduct(v, parent, { listPrice: { set: 70 } }, false).warn, ['Preis wird fixiert (bisher geerbt: 50,00 €)']);
  assert.equal(planProduct(v, parent, { price: { percent: 10 } }, true).follows, true);
  assert.equal(planProduct(prod('w', 5, { parentId: 'p', stock: 2 }), parent, { price: { percent: 10 } }, true).follows, false);
});

test('bulkChangeSet: erbende Varianten werden als „folgen automatisch“ gezählt', () => {
  const parent = prod('p', 50), vs = [1, 2, 3].map(i => prod(`v${i}`, null, { parentId: 'p', active: null, name: null }));
  const { cs } = bulkChangeSet('t', 'r', { price: { percent: 10 } }, [parent, ...vs], { p: parent });
  assert.equal(cs.total, 1); assert.equal(cs.unchanged, 0);
  assert.match(cs.items.find(i => i.id.startsWith('hint:'))!.after, /^3 Varianten erben geänderte Werte vom Hauptprodukt und folgen automatisch/);
});

test('bulkChangeSet: Gruppen statt Tausender Zeilen, Stichprobe begrenzt, Payload vollständig', () => {
  const rows = Array.from({ length: 2400 }, (_, i) => prod(String(i).padStart(4, '0'), 10 + (i % 50), i % 100 === 0 ? { purchasePrices: price(100) } : {}));
  const { cs, payload } = bulkChangeSet('Sommer', 'r', { price: { percent: -10, round: '.99' } }, rows, {});
  assert.equal(cs.total, 2400); assert.equal(payload.plans.length, 2400);
  assert.deepEqual(cs.items.map(i => [i.id, (i.afterRaw as { count: number }).count]), [['grp:ok', 2376], ['grp:warn', 24]]);
  assert.deepEqual(cs.items[1].warn, ['24× unter Einkaufspreis']);
  assert.match(cs.items[0].fieldLabel, /Preis −10 %, gerundet auf \.99/);
  assert.equal(cs.sample!.length, SAMPLE + 10); // erste 50 + bis zu 10 weitere mit Warnungen
  assert.ok(cs.sample!.every(i => i.entity === 'info'));
  assert.throws(() => bulkChangeSet('x', 'r', { price: { set: 10 } }, [prod('a', 10)], {}), /Keine Änderung nötig/);
});

test('planWrite: Rückgängig-Daten exakt (geerbter Preis → null, berechnete Felder entfernt)', () => {
  const parent = prod('p', 50, { price: price(50, 60) }), v = prod('v', null, { parentId: 'p', tax: null, stock: 3 });
  const { row, back } = planWrite({ id: 'v', group: 'ok', price: { gross: 45 }, stock: 0 }, v, parent);
  assert.deepEqual(back, { id: 'v', price: null, stock: 3 });
  // relativer Bestand: auf den beim Anwenden aktuellen Wert (inzwischen 8 statt 3), nie negativ
  assert.deepEqual(planWrite({ id: 'v', group: 'ok', stockAdd: -2 }, { ...v, stock: 8 }), { row: { id: 'v', stock: 6 }, back: { id: 'v', stock: 8 } });
  assert.equal(planWrite({ id: 'v', group: 'ok', stockAdd: -20 }, v).row.stock, 0);
  assert.deepEqual((row.price as SwEntity[])[0], { currencyId: 'eur', gross: 45, net: 37.8151, linked: true, listPrice: { currencyId: 'eur', gross: 60, net: 50.4202, linked: true } });
  const own = prod('o', 20);
  assert.deepEqual(planWrite({ id: 'o', group: 'ok', price: { list: null } }, own).back.price, cleanPrices(own.price));
  assert.equal('apiAlias' in (cleanPrices(own.price)![0] as object), false);
});

test('applyBulk: Blöcke à 50 per Sync, Fortschritt, Rückgängig je Block, Einzel-Fallback bei Fehler', async () => {
  const db: Record<string, SwEntity> = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`id${i}`, prod(`id${i}`, 10)]));
  const calls: string[] = [];
  const sw = {
    search: async (_e: string, c: { ids: string[] }) => ({ data: c.ids.map(id => db[id]).filter(Boolean) }),
    req: async (m: string, path: string, body: { payload: SwEntity[] }[]) => { calls.push(`${m} ${path} ${body[0].payload.length}`); if (body[0].payload.some(r => r.id === 'id77')) throw new Error('kaputt'); },
    update: async (_e: string, id: string) => { calls.push(`PATCH ${id}`); if (id === 'id77') throw new Error('ungültig'); },
  } as unknown as Shopware;
  delete db.id5;
  const plans = Object.keys(db).concat('id5').map(id => ({ id, group: 'ok' as const, stock: 1 }));
  const progress: number[] = [];
  const res = await applyBulk(sw, { items: [], sample: [{ id: 'id0' }, { id: 'id77' }] } as never, { plans } as BulkPayload, new Set(['grp:ok']), { progress: d => progress.push(d) });
  // kompakt: Gruppenzeile + Stichprobe + Fehler, Zahlen in counts
  assert.deepEqual(res.counts, { applied: 118, failed: 2 });
  assert.deepEqual(res.results.map(r => r.itemId).sort(), ['grp:ok', 'id0', 'id5', 'id77']);
  assert.deepEqual(res.results.find(r => r.itemId === 'grp:ok'), { itemId: 'grp:ok', ok: false, error: '2 von 120 fehlgeschlagen' });
  assert.deepEqual(res.results.filter(r => !r.ok && r.itemId !== 'grp:ok').map(r => [r.itemId, r.error]).sort(), [['id5', 'Produkt nicht mehr vorhanden'], ['id77', 'ungültig']]);
  assert.equal(progress[0], 0); assert.equal(progress.at(-1), 120);
  assert.equal(res.undo.length, Math.ceil(120 / CHUNK));
  const undoRows = res.undo.flatMap(u => (u.body as { payload: SwEntity[] }[])[0].payload);
  assert.equal(undoRows.length, 118);
  assert.deepEqual(undoRows.find(r => r.id === 'id0'), { id: 'id0', stock: 10 });
  assert.ok(calls.includes('PATCH id78') && !calls.includes('PATCH id1'));
  // abgewählte Gruppe: nichts geschrieben
  const none = await applyBulk(sw, { items: [] } as never, { plans: plans.map(p => ({ ...p, group: 'warn' as const })) }, new Set(['grp:ok']));
  assert.deepEqual([none.results.length, none.counts], [0, { applied: 0, failed: 0 }]);
});

test('applyBulk: Stale-Write-Guard je Block – inzwischen geänderter Preis schlägt nur dieses Produkt fehl, der Block schreibt die übrigen', async () => {
  const db: Record<string, SwEntity> = { a: prod('a', 10), b: prod('b', 10), c: prod('c', 10) };
  db.b.price = price(12); // Admin hat b inzwischen auf 12 € gesetzt
  const synced: SwEntity[][] = [];
  const sw = {
    search: async (_e: string, c: { ids: string[] }) => ({ data: c.ids.map(id => db[id]).filter(Boolean) }),
    req: async (_m: string, _p: string, body: { payload: SwEntity[] }[]) => { synced.push(body[0].payload); },
    update: async () => { throw new Error('nicht erwartet'); },
  } as unknown as Shopware;
  const plans = ['a', 'b', 'c'].map(id => planProduct(prod(id, 10), undefined, { price: { percent: -10 } }, false).plan!);
  assert.deepEqual(plans[0].prev, { gross: 10 });
  const res = await applyBulk(sw, { items: [] } as never, { plans }, new Set(['grp:ok']));
  assert.deepEqual(res.counts, { applied: 2, failed: 1 });
  assert.deepEqual(res.results.filter(r => r.itemId !== 'grp:ok'), [{ itemId: 'b', ok: false, error: 'Preis: inzwischen geändert, bitte neu vorschlagen' }]);
  assert.deepEqual(synced.map(rows => rows.map(r => r.id)), [['a', 'c']]);
  assert.deepEqual(res.undo.length, 1);
  // bulkStale: unverändert bzw. Altbestand ohne prev → null; Variante mit geerbtem Preis prüft den wirksamen Wert des Hauptprodukts
  assert.equal(bulkStale(plans[0], prod('a', 10)), null);
  assert.equal(bulkStale({ id: 'x', group: 'ok', stock: 1 }, prod('x', 99)), null);
  const parent = prod('p', 50), v = prod('v', null, { parentId: 'p', active: null, name: null });
  const vp = planProduct(v, parent, { price: { percent: 10 } }, false).plan!;
  assert.equal(bulkStale(vp, v, parent), null); assert.equal(bulkStale(vp, v, prod('p', 55)), 'Preis');
  // Bestand relativ (add): Verkäufe dazwischen sind keine Stale-Änderung; Bestand absolut (set) schon
  assert.equal(bulkStale(planProduct(prod('s', 5, { stock: 2 }), undefined, { stock: { add: 3 } }, false).plan!, prod('s', 5, { stock: 7 })), null);
  assert.equal(bulkStale(planProduct(prod('s', 5, { stock: 2 }), undefined, { stock: { set: 9 } }, false).plan!, prod('s', 5, { stock: 7 })), 'Bestand');
  assert.equal(bulkStale(planProduct(prod('t', 5), undefined, { active: false }, false).plan!, prod('t', 5, { active: false })), 'Aktiv');
});

test('applyBulk: Variante mit eigenem Preis und Steuer, aber geerbtem Aktiv-Status wird geschrieben (Hauptprodukt wird für die Stale-Prüfung geladen)', async () => {
  const parent = prod('p', 50), v = prod('v', 30, { parentId: 'p', active: null, name: null });
  const db: Record<string, SwEntity> = { p: parent, v };
  const searched: string[][] = [], synced: SwEntity[][] = [];
  const sw = {
    search: async (_e: string, c: { ids: string[] }) => { searched.push(c.ids); return { data: c.ids.map(id => db[id]).filter(Boolean) }; },
    req: async (_m: string, _p: string, body: { payload: SwEntity[] }[]) => { synced.push(body[0].payload); },
    update: async () => { throw new Error('nicht erwartet'); },
  } as unknown as Shopware;
  const plan = planProduct(v, parent, { active: false }, false).plan!;
  assert.deepEqual(plan, { id: 'v', group: 'ok', active: false, prev: { active: true } });
  const res = await applyBulk(sw, { items: [] } as never, { plans: [plan] }, new Set(['grp:ok']));
  assert.deepEqual(res.counts, { applied: 1, failed: 0 });
  assert.deepEqual(searched, [['v'], ['p']]);
  assert.deepEqual(synced, [[{ id: 'v', active: false }]]);
  // Hauptprodukt inzwischen deaktiviert → der wirksame Wert der Variante hat sich geändert
  db.p = prod('p', 50, { active: false });
  const stale = await applyBulk(sw, { items: [] } as never, { plans: [plan] }, new Set(['grp:ok']));
  assert.deepEqual(stale.results.filter(r => r.itemId !== 'grp:ok'), [{ itemId: 'v', ok: false, error: 'Aktiv: inzwischen geändert, bitte neu vorschlagen' }]);
});

// ---- resolveProducts gegen einen Fake-Leser, der DAL-Filter (equals, equalsAny, not, range), term und Seiten auswertet ----
type Filter = { type: string; field: string; value: unknown; queries?: Filter[]; parameters?: { gte?: number; lte?: number } };
function catalogReader(products: SwEntity[], manufacturers: SwEntity[] = []) {
  const match = (p: SwEntity, f: Filter): boolean => {
    switch (f.type) {
      case 'equals': return f.field === 'categoriesRo.id' ? (p.categoryIds ?? []).includes(f.value) : (p[f.field] ?? null) === f.value;
      case 'equalsAny': return f.field === 'options.id' || f.field === 'properties.id' ? (p.optionIds ?? []).some((o: string) => (f.value as string[]).includes(o)) : (f.value as unknown[]).includes(p[f.field] ?? null);
      case 'not': return !f.queries!.every(q => match(p, q));
      case 'range': { const v = Number(p[f.field]); return (f.parameters!.gte == null || v >= f.parameters!.gte) && (f.parameters!.lte == null || v <= f.parameters!.lte); }
      default: return true;
    }
  };
  const ro = {
    base: 'http://shop',
    search: async (entity: string, c: { filter?: Filter[]; term?: string; limit?: number; page?: number } = {}) => {
      if (entity === 'product-manufacturer') return { data: manufacturers.filter(m => String(m.name).toLowerCase().includes(String(c.filter![0].value).toLowerCase())) };
      let rows = products.filter(p => (c.filter ?? []).every(f => match(p, f)));
      if (c.term) rows = rows.filter(p => `${p.productNumber} ${p.name ?? ''}`.toLowerCase().includes(c.term!.toLowerCase()));
      const limit = c.limit ?? 25, page = c.page ?? 1;
      return { data: rows.slice((page - 1) * limit, page * limit), total: rows.length };
    },
    get: async () => null, salesChannels: async () => [], req: async () => null,
  } as unknown as ShopReader;
  return ro;
}
const m1 = prod('m1', 20, { productNumber: 'HH-VASE-22', name: 'Vase', manufacturerId: 'mf1', categoryIds: ['wohnen'] });
const m2 = prod('m2', 50, { productNumber: 'HH-PLAID-130', name: 'Plaid', childCount: 2, manufacturerId: 'mf1', categoryIds: ['wohnen'] });
const v1 = prod('v1', null, { parentId: 'm2', productNumber: 'HH-PLAID-130.1', name: null, active: null, optionIds: ['oS'], stock: 3 });
const v2 = prod('v2', 70, { parentId: 'm2', productNumber: 'HH-PLAID-130.2', name: null, active: null, optionIds: ['oM'] });
const MF2 = 'f'.repeat(32), m3 = prod('m3', 5, { productNumber: 'HB-BECH', name: 'Becher', active: false, manufacturerId: MF2, stock: 0 });
const CATALOG = [m1, m2, v1, v2, m3], MFS = [{ id: 'mf1', name: 'Haus Holm' }, { id: MF2, name: 'Hafenbrise' }];
const ids = (r: { rows: SwEntity[] }) => r.rows.map(p => p.id).sort();

test('resolveProducts: variantOptions liefert nur Varianten, Preisspanne prüft den wirksamen (geerbten) Preis', async () => {
  const ro = catalogReader(CATALOG, MFS);
  const only = await resolveProducts(ro, { variantOptions: ['oS'] });
  assert.deepEqual(ids(only), ['v1']); assert.deepEqual([only.scanned, Object.keys(only.parents).sort()], [1, ['m1', 'm2', 'm3']]);
  const cheap = await resolveProducts(ro, { maxPrice: 30, includeVariants: true });
  assert.deepEqual(ids(cheap), ['m1', 'm3'], 'v1 erbt 50 € und fällt heraus, v2 hat 70 €');
  assert.deepEqual(ids(await resolveProducts(ro, { minPrice: 45, maxPrice: 60, includeVariants: true })), ['m2', 'v1']);
  assert.deepEqual(ids(await resolveProducts(ro, { active: true, includeVariants: true })), ['m1', 'm2', 'v1', 'v2'], 'Varianten erben aktiv');
  assert.deepEqual(ids(await resolveProducts(ro, { maxStock: 0 })), ['m3']);
});

test('resolveProducts: Suchbegriff trifft eine Variante direkt und lädt ihr Hauptprodukt; Hersteller per Name', async () => {
  const ro = catalogReader(CATALOG, MFS);
  const hit = await resolveProducts(ro, { term: 'HH-PLAID-130.2', includeVariants: true });
  assert.deepEqual(ids(hit), ['v2']); assert.equal(hit.parents.m2?.productNumber, 'HH-PLAID-130', 'Hauptprodukt für geerbte Werte nachgeladen');
  assert.deepEqual(ids(await resolveProducts(ro, { term: 'HH-PLAID-130.2' })), [], 'ohne includeVariants nur Hauptprodukte');
  assert.deepEqual(ids(await resolveProducts(ro, { manufacturer: 'haus holm', active: true })), ['m1', 'm2']);
  assert.deepEqual(ids(await resolveProducts(ro, { manufacturer: 'Hafen' })), ['m3'], 'eindeutiger Teiltreffer');
  assert.deepEqual(ids(await resolveProducts(ro, { manufacturer: MF2 })), ['m3'], 'per id');
  await assert.rejects(resolveProducts(ro, { manufacturer: 'Nix' }), /nicht eindeutig gefunden/);
});

test('resolveProducts: Deckel nennt immer den Gesamtdeckel, auch wenn die Hauptprodukte ihn schon ausschöpfen', async () => {
  const many = (total: number): ShopReader => ({
    base: 'http://shop', get: async () => null, salesChannels: async () => [], req: async () => null,
    search: async (_e, c = {}) => { const limit = Number(c.limit), from = (Number(c.page ?? 1) - 1) * limit, n = Math.max(0, Math.min(limit, total - from)); return { data: Array.from({ length: n }, (_, k) => prod(`p${from + k}`, 1)), total }; },
  });
  await assert.rejects(resolveProducts(many(BULK_SCAN + 1), {}), /^Error: Mehr als 20\.000 Produkte passen auf den Filter, bitte enger filtern/);
  await assert.rejects(resolveProducts(many(BULK_SCAN), { includeVariants: true }), /Mehr als 20\.000 Produkte/, 'kein „Mehr als 0 Produkte“');
  assert.equal((await resolveProducts(many(BULK_SCAN), {})).rows.length, BULK_SCAN, 'genau am Deckel ohne Varianten erlaubt');
});

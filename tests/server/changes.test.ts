import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePrice, undoOps } from '../../src/server/changes';
import type { PageSpec } from '../../src/server/cms';
import type { Shopware } from '../../src/server/shopware';

test('resolvePrice: feste Zahl wird auf Cent gerundet', () => {
  assert.equal(resolvePrice(10, 19.999), 20);
  assert.equal(resolvePrice(null, 12.345), 12.35);
});

test('resolvePrice: null entfernt (Streichpreis)', () => {
  assert.equal(resolvePrice(10, null), null);
});

test('resolvePrice: set mit und ohne Rundung', () => {
  assert.equal(resolvePrice(null, { set: 19.994 }), 19.99);
  assert.equal(resolvePrice(5, { set: 20.2, round: '.99' }), 19.99);
});

test('resolvePrice: Prozent-Regel mit .99-Rundung', () => {
  assert.equal(resolvePrice(20, { percent: -10, round: '.99' }), 17.99);
  assert.equal(resolvePrice(100, { percent: 10 }), 110);
  assert.equal(resolvePrice(19.99, { percent: -10 }), 17.99);
});

test('resolvePrice: add-Regel mit .00-Rundung', () => {
  assert.equal(resolvePrice(10, { add: 2.5, round: '.00' }), 13);
  assert.equal(resolvePrice(10, { add: 2.4, round: '.00' }), 12);
});

test('resolvePrice: Rundung nie unter den Rundungswert', () => {
  assert.equal(resolvePrice(0.3, { percent: 0, round: '.99' }), 0.99);
});

test('resolvePrice: Regel ohne aktuellen Preis bzw. unbekannte Regel wirft', () => {
  assert.throws(() => resolvePrice(null, { percent: 10 }), /Aktueller Preis unbekannt/);
  assert.throws(() => resolvePrice(10, {}), /Unbekannte Preisregel/);
});

test('resolvePrice: Rundungsmodus wird geprüft (Komma erlaubt, "99"/"1.99"/"abc" sind Fehler statt falscher Preise)', () => {
  assert.equal(resolvePrice(18, { percent: 0, round: ',99' }), 17.99);
  assert.equal(resolvePrice(18, { percent: 0, round: '0,99' }), 17.99);
  assert.equal(resolvePrice(18.2, { percent: 0, round: '0.95' }), 17.95);
  assert.equal(resolvePrice(18.2, { percent: 0, round: '.5' }), 18.5);
  assert.equal(resolvePrice(18.234, { percent: 0, round: 'none' }), 18.23);
  for (const round of ['99', '1.99', 'abc', '.999', '-.99']) assert.throws(() => resolvePrice(18, { percent: -10, round }), /round ".*" ungültig/, round);
  assert.throws(() => resolvePrice(null, { set: 20, round: '99' }), /ungültig/);
});

test('Produktänderung: ungültiger Rundungsmodus landet in skipped, nicht als Preis im Set', async () => {
  const { buildProductChangeSet } = await import('../../src/server/changes');
  const rows = [{ id: 'p1', productNumber: 'A', name: 'A', price: [{ currencyId: 'eur', gross: 20 }], tax: { taxRate: 19 } }];
  const ro = { search: async () => ({ data: rows }) } as unknown as Parameters<typeof buildProductChangeSet>[0];
  await assert.rejects(buildProductChangeSet(ro, { title: 't', reason: 'r', changes: [{ id: 'p1', fields: { price: { percent: -10, round: '99' } } }] }), /1 übersprungen: price: round "99" ungültig/);
  const cs = await buildProductChangeSet(ro, { title: 't', reason: 'r', changes: [{ id: 'p1', fields: { price: { percent: -10, round: '99' }, stock: 3 } }] });
  assert.equal(cs.items.length, 1); assert.equal(cs.items[0].field, 'stock');
  assert.match(cs.skipped[0].reason, /round "99" ungültig/);
});

// ---- Executor (einziger schreibender Code) gegen einen Fake-Shopware mit Aufrufprotokoll ----
interface Call { m: string; entity: string; id?: string; data?: unknown }
function fakeShopware(db: Record<string, Record<string, unknown>[]>, opts: { failUpdate?: (entity: string, id: string) => Error | null } = {}) {
  const calls: Call[] = [];
  const find = (entity: string, id: string) => db[entity]?.find(r => r.id === id) ?? null;
  const sw = {
    base: 'http://shop',
    search: async (entity: string, c: { ids?: string[]; filter?: { field: string; value: unknown }[] } = {}) => {
      let rows = db[entity] ?? [];
      if (c.ids) rows = rows.filter(r => c.ids!.includes(r.id as string));
      for (const f of c.filter ?? []) rows = rows.filter(r => r[f.field] === f.value);
      return { data: rows.map(r => ({ ...r })), total: rows.length }; // Kopien wie echte API-Antworten
    },
    get: async (entity: string, id: string) => { const r = find(entity, id); return r ? { ...r } : null; },
    salesChannels: async () => db['sales-channel'] ?? [],
    create: async (entity: string, data: Record<string, unknown>) => { calls.push({ m: 'POST', entity, data }); (db[entity] ||= []).push({ ...data }); return null; },
    update: async (entity: string, id: string, data: Record<string, unknown>) => {
      const e = opts.failUpdate?.(entity, id); if (e) throw e;
      calls.push({ m: 'PATCH', entity, id, data }); const row = find(entity, id); if (!row) throw Object.assign(new Error('404'), { status: 404 }); Object.assign(row, data); return null;
    },
    req: async (m: string, path: string) => { const [, entity, id] = path.split('/'); calls.push({ m, entity, id }); if (m === 'DELETE' && db[entity]) db[entity] = db[entity].filter(r => r.id !== id); return null; },
  };
  return { sw: sw as unknown as Shopware, calls, db };
}
const item = (entityId: string, field: string, afterRaw: unknown, entity = 'product') => ({ id: `${entityId}:${field}`, entity, entityId, label: entityId, field, fieldLabel: field, before: '', after: '', afterRaw, warn: [] });
const all = (cs: { items: { id: string }[] }) => new Set(cs.items.map(i => i.id));

test('applyChangeSet: Preis + Streichpreis → ein PATCH mit brutto/netto (19 %)/linked, zweite Währung bleibt, Rückgängig = alter Preis', async () => {
  const { applyChangeSet } = await import('../../src/server/changes');
  const old = [{ currencyId: 'eur', gross: 20, net: 16.8067, linked: true }, { currencyId: 'usd', gross: 25, net: 21, linked: true }];
  const f = fakeShopware({ product: [{ id: 'p1', price: old.map(p => ({ ...p })), tax: { taxRate: 19 } }] });
  const cs = { id: 'cs', kind: 'products', entity: 'product', title: 't', reason: null, atomic: false, skipped: [], items: [item('p1', 'price', 17.99), item('p1', 'listPrice', 24.99), item('p1', 'name', 'Neu')] };
  const r = await applyChangeSet(f.sw, cs, undefined, all(cs));
  assert.deepEqual(r.results.map(x => x.ok), [true, true, true]);
  assert.equal(f.calls.length, 1, 'eine Entität = ein PATCH');
  const body = f.calls[0].data as { name: string; price: { currencyId: string; gross: number; net: number; linked: boolean; listPrice?: { gross: number; net: number } }[] };
  assert.equal(body.name, 'Neu');
  assert.equal(body.price.length, 2); assert.equal(body.price[1].currencyId, 'usd');
  assert.equal(body.price[0].gross, 17.99); assert.equal(body.price[0].net, 15.1176); assert.equal(body.price[0].linked, true);
  assert.equal(body.price[0].listPrice?.gross, 24.99); assert.equal(body.price[0].listPrice?.net, 21.0);
  assert.deepEqual(r.undo, [{ op: 'patch', entity: 'product', id: 'p1', data: { name: null, price: old } }]);
});

test('applyChangeSet: Preis-PATCH behält den Grundpreis (regulationPrice)', async () => {
  const { applyChangeSet } = await import('../../src/server/changes');
  const reg = { currencyId: 'eur', gross: 12, net: 10.084, linked: false, apiAlias: 'price' };
  const old = [{ currencyId: 'eur', gross: 20, net: 16.8067, linked: true, regulationPrice: reg }];
  const f = fakeShopware({ product: [{ id: 'p1', price: [{ ...old[0], regulationPrice: { ...reg } }], tax: { taxRate: 19 } }] });
  const cs = { id: 'cs', kind: 'products', entity: 'product', title: 't', reason: null, atomic: false, skipped: [], items: [item('p1', 'price', 17.99), item('p1', 'listPrice', 24.99)] };
  const r = await applyChangeSet(f.sw, cs, undefined, all(cs));
  assert.ok(r.results.every(x => x.ok));
  const entry = (f.calls[0].data as { price: { gross: number; listPrice?: { gross: number }; regulationPrice?: Record<string, unknown> }[] }).price[0];
  assert.equal(entry.gross, 17.99); assert.equal(entry.listPrice?.gross, 24.99);
  assert.deepEqual(entry.regulationPrice, { currencyId: 'eur', gross: 12, net: 10.084, linked: false });
});

test('applyChangeSet: Variante ohne eigenen Preis nimmt Basis/Steuer vom Hauptprodukt, Rückgängig stellt die Vererbung (price null) wieder her', async () => {
  const { applyChangeSet } = await import('../../src/server/changes');
  const f = fakeShopware({ product: [{ id: 'v1', parentId: 'p', price: null, tax: null }, { id: 'p', price: [{ currencyId: 'eur', gross: 89, listPrice: { currencyId: 'eur', gross: 99 } }], tax: { taxRate: 7 } }] });
  const cs = { id: 'cs', kind: 'products', entity: 'product', title: 't', reason: null, atomic: false, skipped: [], items: [item('v1', 'listPrice', 120)] };
  const r = await applyChangeSet(f.sw, cs, undefined, all(cs));
  assert.equal(r.results[0].ok, true);
  const body = f.calls[0].data as { price: { gross: number; net: number; listPrice: { gross: number; net: number } }[] };
  assert.equal(body.price[0].gross, 89); assert.equal(body.price[0].net, 83.1776); assert.equal(body.price[0].listPrice.gross, 120);
  assert.deepEqual(r.undo[0], { op: 'patch', entity: 'product', id: 'v1', data: { price: null } });
  const back = fakeShopware({ product: [{ id: 'v1', parentId: 'p', price: [{ gross: 89 }] }] });
  const cs2 = { ...cs, items: [item('v1', 'price', null)] };
  await applyChangeSet(back.sw, cs2, undefined, all(cs2));
  assert.deepEqual(back.calls[0].data, { price: null });
});

test('applyChangeSet: nur ausgewählte Elemente, Fehler je Entität (andere laufen weiter), FAQ als Zusatzfeld', async () => {
  const { applyChangeSet } = await import('../../src/server/changes');
  const f = fakeShopware({ product: [{ id: 'a', stock: 1, customFields: { aicb_blocks: { x: 1 } } }, { id: 'b', stock: 2 }, { id: 'c' }], 'custom-field-set': [{ id: 'cfs', name: 'aicb_content' }] }, { failUpdate: (_e, id) => (id === 'b' ? new Error('gesperrt') : null) });
  const faq = { title: 'FAQ', items: [{ q: 'A?', a: 'B.' }, { q: 'C?', a: 'D.' }] };
  const cs = { id: 'cs', kind: 'products', entity: 'product', title: 't', reason: null, atomic: false, skipped: [], items: [item('a', 'stock', 5), item('a', 'faq', faq), item('b', 'stock', 0), item('c', 'stock', 9)] };
  const r = await applyChangeSet(f.sw, cs, undefined, new Set(['a:stock', 'a:faq', 'b:stock']));
  assert.deepEqual(Object.fromEntries(r.results.map(x => [x.itemId, x.ok])), { 'a:stock': true, 'a:faq': true, 'b:stock': false });
  assert.match(r.results.find(x => x.itemId === 'b:stock')!.error!, /gesperrt/);
  assert.equal(f.calls.filter(c => c.m === 'PATCH').length, 1, 'c nicht ausgewählt, b fehlgeschlagen');
  const body = f.calls[0].data as { stock: number; customFields: { aicb_blocks: { x: number; faq: unknown; faq_html: string } } };
  assert.equal(body.stock, 5); assert.equal(body.customFields.aicb_blocks.x, 1); assert.deepEqual(body.customFields.aicb_blocks.faq, faq.items); assert.match(body.customFields.aicb_blocks.faq_html, /A\?/);
  assert.deepEqual(r.undo, [{ op: 'patch', entity: 'product', id: 'a', data: { stock: 1, customFields: { aicb_blocks: { x: 1 } } } }]);
});

// ---- Stale-Write-Guard: inzwischen geänderte Felder werden nicht geschrieben, die übrigen schon ----
const gi = (entityId: string, field: string, afterRaw: unknown, beforeRaw: unknown, fieldLabel: string, entity = 'product') => ({ ...item(entityId, field, afterRaw, entity), fieldLabel, beforeRaw });
const setOf = (kind: 'products' | 'categories', items: ReturnType<typeof gi>[]) => ({ id: 'cs', kind, entity: kind === 'products' ? 'product' : 'category', title: 't', reason: null, atomic: false, skipped: [], items });

test('normValue/isStale: Formatierung ist keine Änderung, echte Änderung schon; ohne Snapshot (Altbestand) keine Prüfung', async () => {
  const { normValue, isStale } = await import('../../src/server/changes');
  assert.equal(normValue('<p>Hallo  Welt</p>\n  <p>x</p>'), normValue('<p>Hallo Welt</p><p>x</p>'));
  assert.equal(normValue(17.99), normValue(17.990000001));
  assert.equal(normValue({ a: null, b: 1 }), normValue({ b: 1 }));
  assert.equal(normValue([]), normValue(null)); assert.equal(normValue(''), normValue(undefined));
  assert.equal(isStale('x', undefined), false, 'kein Snapshot → keine Prüfung');
  assert.equal(isStale(null, ''), false);
  assert.equal(isStale(20, 22), true); assert.equal(isStale(false, true), true);
  assert.equal(isStale([{ q: 'a', a: 'b' }], [{ q: 'a', a: 'c' }]), true);
});

test('Stale-Write-Guard Produkt: Preis/Text/FAQ inzwischen geändert → nur diese Felder fehlgeschlagen und nicht im PATCH, übrige Felder derselben Entität schon', async () => {
  const { applyChangeSet } = await import('../../src/server/changes');
  // Vorschlag sah Preis 20, Beschreibung „<p>alt</p>“, 1 FAQ; Admin hat inzwischen Preis 22 und die FAQ geändert, der Name blieb
  const faqAlt = [{ q: 'A?', a: 'B.' }], faqNeu = { title: 'FAQ', items: [{ q: 'A?', a: 'B.' }, { q: 'C?', a: 'D.' }] };
  const f = fakeShopware({ product: [{ id: 'p1', name: 'Alt', description: '<p>alt</p>', price: [{ currencyId: 'eur', gross: 22, net: 18.49, linked: true }], tax: { taxRate: 19 }, customFields: { aicb_blocks: { faq: [{ q: 'A?', a: 'Admin.' }] } } }], 'custom-field-set': [{ id: 'cfs', name: 'aicb_content' }] });
  const cs = setOf('products', [gi('p1', 'price', 17.99, 20, 'Preis (brutto)'), gi('p1', 'name', 'Neu', 'Alt', 'Name'), gi('p1', 'description', '<p>neu</p>', '<p>alt</p>\n', 'Beschreibung'), gi('p1', 'faq', faqNeu, faqAlt, 'FAQ (Zusatzfeld)')]);
  const r = await applyChangeSet(f.sw, cs, undefined, all(cs));
  assert.deepEqual(r.results, [
    { itemId: 'p1:price', ok: false, error: 'Preis (brutto): inzwischen geändert, bitte neu vorschlagen' }, { itemId: 'p1:name', ok: true }, { itemId: 'p1:description', ok: true },
    { itemId: 'p1:faq', ok: false, error: 'FAQ (Zusatzfeld): inzwischen geändert, bitte neu vorschlagen' },
  ]);
  assert.equal(f.calls.filter(c => c.m === 'PATCH').length, 1);
  assert.deepEqual(f.calls[0].data, { name: 'Neu', description: '<p>neu</p>' }, 'Preis und FAQ nicht geschrieben');
  assert.deepEqual(r.undo, [{ op: 'patch', entity: 'product', id: 'p1', data: { name: 'Alt', description: '<p>alt</p>' } }]);
  // alle Felder der Entität stale → kein Schreibzugriff, kein Rückgängig-Schritt
  const g = fakeShopware({ product: [{ id: 'p1', price: [{ currencyId: 'eur', gross: 22 }], tax: { taxRate: 19 } }] });
  const cs2 = setOf('products', [gi('p1', 'price', 17.99, 20, 'Preis (brutto)'), gi('p1', 'listPrice', 29, null, 'Streichpreis (brutto)')]);
  const r2 = await applyChangeSet(g.sw, cs2, undefined, all(cs2));
  assert.deepEqual(r2.results.map(x => x.ok), [false, true], 'Streichpreis war und ist leer: wird mit dem frischen Preis 22 geschrieben');
  assert.deepEqual((g.calls[0].data as { price: { gross: number; listPrice: { gross: number } }[] }).price[0].gross, 22);
  const h = fakeShopware({ product: [{ id: 'p1', stock: 3 }] });
  const cs3 = setOf('products', [gi('p1', 'stock', 0, 5, 'Bestand')]);
  const r3 = await applyChangeSet(h.sw, cs3, undefined, all(cs3));
  assert.deepEqual([r3.results[0].ok, h.calls.length, r3.undo], [false, 0, []]);
});

test('Stale-Write-Guard Kategorie: Beschreibung inzwischen geändert → fehlgeschlagen; unveränderte Felder (auch nur anders formatiert) schreiben wie bisher', async () => {
  const { applyChangeSet } = await import('../../src/server/changes');
  const f = fakeShopware({ category: [{ id: 'c1', name: 'Wohnen', description: '<p>vom Admin</p>', translated: { name: 'Wohnen', metaTitle: 'Wohnen | Shop' } }] });
  const cs = setOf('categories', [gi('c1', 'description', '<p>neu</p>', '<p>alt</p>', 'Beschreibung', 'category'), gi('c1', 'name', 'Wohnen & Leben', 'Wohnen', 'Name', 'category'), gi('c1', 'metaTitle', 'Neu', 'Wohnen  |  Shop', 'Meta-Title', 'category')]);
  const r = await applyChangeSet(f.sw, cs, undefined, all(cs));
  assert.deepEqual(r.results.map(x => [x.ok, x.error]), [[false, 'Beschreibung: inzwischen geändert, bitte neu vorschlagen'], [true, undefined], [true, undefined]]);
  assert.deepEqual(f.calls[0].data, { name: 'Wohnen & Leben', metaTitle: 'Neu' });
  // unveränderter Shop: alles wird geschrieben, Verhalten wie ohne Guard
  const g = fakeShopware({ product: [{ id: 'p1', name: 'Alt', price: [{ currencyId: 'eur', gross: 20, net: 16.81, linked: true }], tax: { taxRate: 19 } }] });
  const cs2 = setOf('products', [gi('p1', 'price', 17.99, 20, 'Preis (brutto)'), gi('p1', 'name', 'Neu', 'Alt', 'Name'), gi('p1', 'description', '<p>x</p>', null, 'Beschreibung')]);
  const r2 = await applyChangeSet(g.sw, cs2, undefined, all(cs2));
  assert.deepEqual(r2.results.map(x => x.ok), [true, true, true]);
  assert.equal((g.calls[0].data as { price: { gross: number }[] }).price[0].gross, 17.99);
});

test('Builder merkt den Rohwert (beforeRaw) je Feld: Preis, Text, Zahl, FAQ', async () => {
  const { buildProductChangeSet } = await import('../../src/server/changes');
  const rows = [{ id: 'p1', productNumber: 'A', name: 'A', description: '<p>alt</p>', stock: 4, price: [{ currencyId: 'eur', gross: 20, listPrice: { gross: 25 } }], tax: { taxRate: 19 }, customFields: { aicb_blocks: { faq: [{ q: 'x', a: 'y' }] } } }];
  const ro = { search: async () => ({ data: rows }) } as unknown as Parameters<typeof buildProductChangeSet>[0];
  const cs = await buildProductChangeSet(ro, { title: 't', reason: 'r', changes: [{ id: 'p1', fields: { price: 18, listPrice: null, description: '<p>neu</p>', stock: 0, metaTitle: 'M', faq: [{ q: 'a', a: 'b' }, { q: 'c', a: 'd' }] } }] });
  assert.deepEqual(Object.fromEntries(cs.items.map(i => [i.field, i.beforeRaw])), { price: 20, listPrice: 25, description: '<p>alt</p>', stock: 4, metaTitle: null, faq: [{ q: 'x', a: 'y' }] });
});

const SPEC = { name: 'Seite X', type: 'product_list', sections: [{ blocks: [{ type: 'text', html: '<p>Hallo</p>' }, { type: 'product-listing' }] }] } as unknown as PageSpec;
const pageCs = (items: string[]) => ({ id: 'cs', kind: 'page', title: 't', reason: null, atomic: true, skipped: [], items: items.map(id => ({ id, entity: 'info', label: id, fieldLabel: '', before: '', after: '', warn: [] })) });

test('applyPublish: Fehler nach dem Anlegen des Layouts nimmt das Layout wieder zurück (atomar), alle Zeilen fehlgeschlagen, kein verwaistes Rückgängig', async () => {
  const { applyChangeSet } = await import('../../src/server/changes');
  const f = fakeShopware({ category: [{ id: 'cat', cmsPageId: 'alt' }], 'sales-channel': [{ id: 'sc', domains: [{ url: 'https://shop.test' }] }] }, { failUpdate: (e) => (e === 'category' ? Object.assign(new Error('Shopware PATCH /category/cat → 400: metaTitle zu lang'), { status: 400 }) : null) });
  const r = await applyChangeSet(f.sw, pageCs(['i0', 'i1']), { spec: SPEC, args: { target: 'category', categoryId: 'cat', metaTitle: 'x'.repeat(300) } }, new Set(['i0', 'i1']));
  assert.deepEqual(r.results.map(x => x.ok), [false, false]);
  assert.match(r.error!, /metaTitle zu lang/); assert.match(r.error!, /Layout wieder entfernt/);
  assert.deepEqual(r.undo, []);
  assert.deepEqual(f.calls.map(c => `${c.m} ${c.entity}`), ['POST cms-page', 'DELETE cms-page']);
  assert.equal(f.db['cms-page'].length, 0, 'kein verwaistes Layout im Shop');
  assert.equal(f.db.category[0].cmsPageId, 'alt');
  // gelöschte Kategorie: klarer Fehler statt TypeError
  const g = fakeShopware({ 'sales-channel': [] });
  const r2 = await applyChangeSet(g.sw, pageCs(['i0']), { spec: SPEC, args: { target: 'category', categoryId: 'weg' } }, new Set(['i0']));
  assert.match(r2.error!, /Kategorie nicht mehr vorhanden/); assert.equal(g.db['cms-page'].length, 0);
});

test('applyPublish: Erfolg liefert Rückgängig für Layout und Zuweisung; scheitert die Rückabwicklung, bleibt der Rest-Undo erhalten', async () => {
  const { applyChangeSet, undoOps } = await import('../../src/server/changes');
  const f = fakeShopware({ category: [{ id: 'cat', cmsPageId: 'alt', metaTitle: 'Alt' }], 'sales-channel': [{ id: 'sc', domains: [{ url: 'https://shop.test' }] }] });
  const r = await applyChangeSet(f.sw, pageCs(['i0', 'i1']), { spec: SPEC, args: { target: 'category', categoryId: 'cat', metaTitle: 'Neu' } }, new Set(['i0', 'i1']));
  assert.deepEqual(r.results.map(x => x.ok), [true, true]);
  assert.equal(r.undo.length, 2); assert.equal(r.undo[0].op, 'delete'); assert.deepEqual(r.undo[1], { op: 'patch', entity: 'category', id: 'cat', data: { cmsPageId: 'alt', metaTitle: 'Alt' } });
  assert.equal(r.published?.storefront, 'https://shop.test/navigation/cat');
  assert.equal(f.db.category[0].cmsPageId, r.published?.cmsPageId);
  await undoOps(f.sw, r.undo);
  assert.equal(f.db.category[0].cmsPageId, 'alt'); assert.equal(f.db.category[0].metaTitle, 'Alt'); assert.equal(f.db['cms-page'].length, 0);
  // Landingpage: Rückabwicklung scheitert (DELETE wirft) → Undo bleibt in der Antwort
  const g = fakeShopware({ 'sales-channel': [{ id: 'sc', domains: [{ url: 'https://shop.test' }] }] });
  g.sw.create = async (entity: string, data: Record<string, unknown>) => { if (entity === 'landing-page') throw new Error('400: url belegt'); g.calls.push({ m: 'POST', entity, data }); (g.db[entity] ||= []).push(data); return null; };
  g.sw.req = async () => { throw Object.assign(new Error('500'), { status: 500 }); };
  const r2 = await applyChangeSet(g.sw, pageCs(['i0']), { spec: { ...SPEC, type: 'landingpage' } as PageSpec, args: { target: 'landingpage', url: 'ratgeber/x', salesChannelId: 'sc' } }, new Set(['i0']));
  assert.match(r2.error!, /url belegt/); assert.match(r2.error!, /Rückabwicklung unvollständig/);
  assert.equal(r2.undo.length, 1); assert.equal(r2.undo[0].entity, 'cms-page');
});

test('buildPublishChangeSet: Landingpage-URL wird normalisiert, ungültige URL/Duplikat/fehlende Kategorie/zu lange Metas werden abgelehnt', async () => {
  const { buildPublishChangeSet, landingSlug } = await import('../../src/server/changes');
  assert.equal(landingSlug('/Ratgeber/Garten-Duschen/'), 'ratgeber/garten-duschen');
  for (const u of ['Ratgeber/Garten Duschen?x=1', 'a#b', 'ä', 'a//b', '', 'a?x']) assert.throws(() => landingSlug(u), /ungültig/, u);
  const f = fakeShopware({ category: [{ id: 'cat', translated: { name: 'Vasen' } }], product: [{ id: 'p1', translated: { name: 'P' } }], 'sales-channel': [{ id: 'sc', translated: { name: 'Storefront' } }], 'landing-page': [{ id: 'lp', url: 'ratgeber/alt', name: 'Alt', salesChannels: [{ id: 'sc' }] }] });
  f.sw.search = (async (entity: string, c: { filter?: { field: string; value: unknown }[]; ids?: string[] }) => { // Fake: Verkaufskanal-Filter über die Zuordnung
    let rows = f.db[entity] ?? []; if (c.ids) rows = rows.filter(r => c.ids!.includes(r.id as string));
    for (const fl of c.filter ?? []) rows = rows.filter(r => (fl.field === 'salesChannels.id' ? (r.salesChannels as { id: string }[]).some(s => s.id === fl.value) : r[fl.field] === fl.value));
    return { data: rows, total: rows.length };
  }) as Shopware['search'];
  const lp = async (url: string, sc = 'sc') => buildPublishChangeSet(f.sw, { ...SPEC, type: 'landingpage' } as PageSpec, { target: 'landingpage', url, salesChannelId: sc });
  const ok = await lp('/Ratgeber/Neu/');
  assert.equal(ok.items[1].after, '/ratgeber/neu'); assert.equal(ok.atomic, true);
  await assert.rejects(lp('ratgeber/alt'), /schon die Landingpage „Alt“/);
  await assert.rejects(lp('Ratgeber/Garten Duschen?x=1'), /ungültig/);
  await assert.rejects(lp('ratgeber/neu', 'fremd'), /Verkaufskanal fremd nicht gefunden/);
  await assert.rejects(buildPublishChangeSet(f.sw, SPEC, { target: 'category', categoryId: 'weg' }), /Kategorie weg nicht gefunden/);
  await assert.rejects(buildPublishChangeSet(f.sw, SPEC, { target: 'category', categoryId: 'cat', metaTitle: 'x'.repeat(256) }), /metaTitle: max. 255 Zeichen/);
  await assert.rejects(buildPublishChangeSet(f.sw, { ...SPEC, type: 'product_detail' } as PageSpec, { target: 'product', productIds: ['p1', 'p2'] }), /Produkt nicht gefunden: p2/);
  const cat = await buildPublishChangeSet(f.sw, SPEC, { target: 'category', categoryId: 'cat', metaTitle: 'Titel' });
  assert.equal(cat.items[1].label, 'Kategorie „Vasen“'); assert.equal(cat.items[2].after, 'Titel');
});

test('Neue Produkte: Änderungsset mit Payload, Standard inaktiv, Preis Pflicht', async () => {
  const { buildNewProductsChangeSet } = await import('../../src/server/changes');
  const ro = { search: async (entity: string) => ({ data: entity === 'tax' ? [{ id: 'tax19', taxRate: 19 }, { id: 'tax7', taxRate: 7 }] : entity === 'category' ? [{ id: 'cat1', name: 'Wohnen' }] : entity === 'media' ? [{ id: 'm1', url: 'http://shop.test/media/a.jpg' }] : [] }) } as unknown as Parameters<typeof buildNewProductsChangeSet>[0];
  const cs = await buildNewProductsChangeSet(ro, { title: 'Neu', reason: 'Fotos', products: [
    { name: 'Vase „Kiesel“', description: '<p>Bauchige Vase.</p>', price: 49, categoryIds: ['cat1'], images: ['m1'] },
    { name: 'Becher', description: '<p>Becher.</p>', price: Number.NaN },
  ] });
  assert.equal(cs.kind, 'new-products');
  assert.equal(cs.items.length, 1);
  const p = cs.items[0].afterRaw as { active: boolean; stock: number; taxId: string; images: string[]; productNumber: string };
  assert.equal(p.active, false); assert.equal(p.stock, 0); assert.equal(p.taxId, 'tax19'); assert.deepEqual(p.images, ['m1']);
  assert.match(p.productNumber, /^VASE-KIES-[A-Z0-9]{4}$/);
  assert.match(cs.items[0].after, /49,00 € · inaktiv \(Entwurf\) · Bestand 0 · Wohnen · 1 Bild/);
  assert.equal(cs.assets?.[0].note, 'Titelbild');
  assert.match(cs.skipped[0].reason, /Preis/);
});

test('Produktänderung: Preisregel auf Variante mit geerbtem Preis (Basis = Hauptprodukt), null = wieder erben', async () => {
  const { buildProductChangeSet } = await import('../../src/server/changes');
  const parent = { id: 'p', productNumber: 'P', name: 'Plaid', price: [{ currencyId: 'eur', gross: 89, listPrice: { gross: 99 } }], tax: { taxRate: 19 } };
  const rows: Record<string, unknown>[] = [{ id: 'v1', parentId: 'p', productNumber: 'P.1', price: null }, { id: 'v2', parentId: 'p', productNumber: 'P.2', price: [{ currencyId: 'eur', gross: 95 }] }, parent];
  const ro = { search: async (_e: string, c: { ids: string[] }) => ({ data: rows.filter(r => c.ids.includes(r.id as string)) }) } as unknown as Parameters<typeof buildProductChangeSet>[0];
  const cs = await buildProductChangeSet(ro, { title: 't', reason: 'r', changes: [
    { id: 'v1', fields: { price: { percent: -10, round: '.99' }, listPrice: { add: 1 } } }, { id: 'v2', fields: { price: null } }, { id: 'v1', fields: { price: null } }, { id: 'p', fields: { price: null } },
  ] });
  const it = Object.fromEntries(cs.items.map(i => [i.id + (i.afterRaw === null ? ':null' : ''), i]));
  assert.equal(it['v1:price'].before, '89,00 € (geerbt)'); assert.equal(it['v1:price'].afterRaw, 79.99);
  assert.equal(it['v1:listPrice'].afterRaw, 100);
  assert.deepEqual(it['v1:listPrice'].warn, []); // Preis wird ohnehin gesetzt
  const only = await buildProductChangeSet(ro, { title: 't', reason: 'r', changes: [{ id: 'v1', fields: { listPrice: 120 } }] });
  assert.deepEqual(only.items[0].warn, ['Preis wird fixiert (bisher geerbt: 89,00 €)']);
  assert.equal(it['v2:price:null'].after, 'erbt vom Hauptprodukt');
  assert.equal(cs.unchanged, 1); // v1 erbt schon
  assert.match(cs.skipped[0].reason, /nur bei Varianten/);
});

test('undoOps: gelöschte Produkte/Kategorien verlieren auch ihre (von Shopware nur als gelöscht markierten) SEO-URLs', async () => {
  const calls: string[] = [];
  const sw = {
    req: async (m: string, path: string) => { calls.push(`${m} ${path}`); return null; },
    search: async (entity: string, c: { filter: { value: string }[] }) => ({ data: entity === 'seo-url' && c.filter[0].value === 'p1' ? [{ id: 's1' }, { id: 's2' }] : [], total: 0 }),
  } as unknown as Shopware;
  const r = await undoOps(sw, [{ op: 'delete', entity: 'product', id: 'p1' }, { op: 'delete', entity: 'product-media', id: 'm1' }]);
  assert.deepEqual(r, [{ ok: true }, { ok: true }]);
  assert.deepEqual(calls, ['DELETE /product-media/m1', 'DELETE /product/p1', 'DELETE /seo-url/s1', 'DELETE /seo-url/s2']);
});

test('undoOps: schon gelöschte Ziele (404) gelten als rückgängig gemacht, andere Fehler nicht', async () => {
  const fail = (status: number) => Object.assign(new Error(`→ ${status}`), { status });
  const sw = {
    req: async (m: string, path: string) => { if (path.includes('gone')) throw fail(404); if (path.includes('locked')) throw fail(400); return null; },
    search: async () => ({ data: [], total: 0 }),
    update: async () => { throw fail(404); },
  } as unknown as Shopware;
  const r = await undoOps(sw, [
    { op: 'patch', entity: 'product', id: 'p', data: {} },
    { op: 'req', entity: 'product', id: 'p', method: 'DELETE', path: '/product/p/tags/locked' },
    { op: 'req', entity: 'product', id: 'p', method: 'DELETE', path: '/product/p/tags/gone' },
    { op: 'delete', entity: 'product-cross-selling', id: 'gone' },
  ]);
  assert.deepEqual(r.map(x => x.ok), [true, true, false, false]);
});

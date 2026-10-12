import { test } from 'node:test';
import assert from 'node:assert/strict';
import { condToNode, renderRule, rowsToTree, sameTree, specToTree, treeToRows, treeToSpec, type FilterNode, type GroupSpec } from '../../../src/server/features/streams-rules';
import { createGuard } from '../../../src/server/policy';
import { ReadOnlyShopware, type ShopReader, type SwEntity } from '../../../src/server/shopware';

const CAT = 'e64ae9711d2b406c8a0608045afa56dd', MAN = 'aa'.repeat(16), OPT = 'bb'.repeat(16), STREAM = 'cc'.repeat(16), SC = 'dd'.repeat(16);
let seq = 0; const ids = () => (++seq).toString(16).padStart(32, '0');

test('Regel → Filterbaum: ODER-Gruppen, UND-Bedingungen, NICHT, Preis/Bestand/Angebot/Datum', () => {
  const t = specToTree([
    { conditions: [{ field: 'category', ids: [CAT] }, { field: 'price', max: 50 }, { field: 'productNumber', values: ['A-1', 'B-2'], negate: true }] },
    { conditions: [{ field: 'onSale', min: 20 }, { field: 'active', value: true }, { field: 'stock', min: 1 }, { field: 'releaseDate', from: '2026-03-01' }] },
  ]);
  assert.equal(t.type, 'multi'); assert.equal(t.operator, 'OR');
  assert.deepEqual(t.queries![0].queries, [
    { type: 'equalsAny', field: 'categoriesRo.id', value: CAT },
    { type: 'range', field: 'cheapestPrice', parameters: { lte: 50 } },
    { type: 'not', operator: 'AND', queries: [{ type: 'equalsAny', field: 'productNumber', value: 'A-1|B-2' }] },
  ]);
  assert.deepEqual(t.queries![1].queries, [
    { type: 'range', field: 'cheapestPrice.percentage', parameters: { gte: 20 } },
    { type: 'equals', field: 'active', value: '1' },
    { type: 'range', field: 'stock', parameters: { gte: 1 } },
    { type: 'range', field: 'releaseDate', parameters: { gte: '2026-03-01' } },
  ]);
  assert.deepEqual(condToNode({ field: 'category', ids: [CAT], includeSubcategories: false }), { type: 'equalsAny', field: 'categories.id', value: CAT });
  assert.deepEqual(condToNode({ field: 'onSale', value: false }), { type: 'not', operator: 'AND', queries: [{ type: 'range', field: 'cheapestPrice.percentage', parameters: { gt: 0 } }] });
});

test('Regel: ungültige Angaben werfen verständliche Fehler', () => {
  assert.throws(() => specToTree([]), /Regel ist leer/);
  assert.throws(() => specToTree([{ conditions: [] }]), /keine Bedingung/);
  assert.throws(() => condToNode({ field: 'price' }), /min und\/oder max/);
  assert.throws(() => condToNode({ field: 'price', min: 60, max: 50 }), /min ist größer/);
  assert.throws(() => condToNode({ field: 'stock', min: 1.5 }), /ganze Zahlen/);
  assert.throws(() => condToNode({ field: 'manufacturer', ids: [] }), /keine IDs/);
  assert.throws(() => condToNode({ field: 'tag', ids: ['nope'] }), /ungültige ID/);
  assert.throws(() => condToNode({ field: 'active' }), /true\/false/);
  assert.throws(() => condToNode({ field: 'releaseDate', from: '1.3.2026' }), /JJJJ-MM-TT/);
  assert.throws(() => condToNode({ field: 'productNumber', values: ['a|b'] }), /„\|“/);
  assert.throws(() => condToNode({ field: 'bogus' } as never), /Unbekanntes Feld/);
});

test('Filterbaum ⇄ Zeilen (product-stream-filter) und zurück zur Regel', () => {
  const groups: GroupSpec[] = [{ conditions: [{ field: 'category', ids: [CAT] }, { field: 'manufacturer', ids: [MAN], negate: true }, { field: 'price', min: 10, max: 50 }] }, { conditions: [{ field: 'onSale' }] }];
  const tree = specToTree(groups), rows = treeToRows([tree], ids);
  assert.equal(rows.length, 1 + 2 + 3 + 1 + 1);
  assert.equal(rows.filter(r => !r.parentId).length, 1);
  assert.ok(rows.every(r => !r.parentId || rows.some(p => p.id === r.parentId)));
  const back = rowsToTree([...rows].reverse()); // Reihenfolge der Zeilen egal, Position zählt
  assert.ok(sameTree(back, [tree]));
  assert.deepEqual(treeToSpec(back), groups);
  assert.equal(treeToSpec([{ type: 'multi', operator: 'OR', queries: [{ type: 'multi', operator: 'AND', queries: [{ type: 'contains', field: 'name', value: 'x' }] }] }]), null);
  assert.ok(!sameTree(back, [specToTree([{ conditions: [{ field: 'price', max: 50 }] }])]));
});

test('Lesbare Regel mit Namen, Klammern bei mehreren Gruppen, unbekannte Felder roh', () => {
  const names = { [CAT]: 'Wohnen › Wohnaccessoires', [MAN]: 'Haus Holm', [OPT]: 'Farbe: Blau' };
  assert.equal(renderRule([specToTree([{ conditions: [{ field: 'category', ids: [CAT] }, { field: 'price', max: 50 }] }])], names), 'Kategorie (inkl. Unterkategorien) = Wohnen › Wohnaccessoires UND Preis ≤ 50,00 €');
  assert.equal(renderRule([specToTree([
    { conditions: [{ field: 'manufacturer', ids: [MAN], negate: true }, { field: 'property', ids: [OPT] }] },
    { conditions: [{ field: 'onSale' }] }, { conditions: [{ field: 'active', value: false }] },
  ])], names), '(Hersteller ≠ Haus Holm UND Eigenschaft = Farbe: Blau) ODER Im Angebot (mit Streichpreis) ODER Aktiv = nein');
  assert.equal(renderRule([specToTree([{ conditions: [{ field: 'stock', min: 1, max: 9 }, { field: 'releaseDate', from: '2026-03-01' }, { field: 'onSale', min: 20 }] }])]), 'Bestand ≥ 1 und ≤ 9 UND Erscheinungsdatum ≥ 01.03.2026 UND Rabatt (Streichpreis) ≥ 20 %');
  assert.equal(renderRule([{ type: 'equalsAny', field: 'manufacturerId', value: 'ff'.repeat(16) }]), 'Hersteller = unbekannt (ffffffff…)');
  assert.equal(renderRule([{ type: 'contains', field: 'product.name', value: 'Vase' }]), 'Name enthält „Vase“');
  assert.equal(renderRule([]), 'alle Produkte (keine Bedingung)');
});

// ---- Änderungssets mit Fake-Shop ----
type Crit = { ids?: string[]; filter?: { field: string; value: unknown }[]; term?: string };
function fakeShop(over: Partial<Record<string, (c: Crit) => SwEntity[]>> = {}, preview = { total: 2 }) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const data: Record<string, (c: Crit) => SwEntity[]> = {
    'sales-channel': () => [{ id: SC, name: 'Storefront', domains: [{ url: 'http://shop' }] }],
    category: c => (c.ids?.includes(CAT) || c.filter?.some(f => f.value === 'Wohnaccessoires') ? [{ id: CAT, name: 'Wohnaccessoires', type: 'page', productAssignmentType: 'product', translated: { name: 'Wohnaccessoires', breadcrumb: ['Katalog', 'Wohnen', 'Wohnaccessoires'] } }] : []),
    'product-manufacturer': c => (c.filter?.some(f => f.value === 'Haus Holm') || c.ids?.includes(MAN) ? [{ id: MAN, name: 'Haus Holm' }] : c.term ? [{ id: MAN, name: 'Haus Holm' }] : []),
    'product-stream': () => [],
    product: () => [],
    'product-cross-selling': () => [],
    ...over,
  };
  const raw: ShopReader = {
    base: 'http://shop',
    search: async (e, c) => { const rows = (data[e] ?? (() => []))((c ?? {}) as Crit); return { data: rows, total: e === 'product' ? 4 : rows.length }; },
    get: async (e, id, c) => (data[e] ?? (() => []))({ ...(c as Crit), ids: [id] }).find(x => x.id === id) ?? null,
    salesChannels: async () => data['sales-channel']({}),
    req: async (method, path, body) => { calls.push({ method, path, body }); return { total: preview.total, elements: { a: { id: 'p1', productNumber: 'HH-VASE-22', translated: { name: 'Vase' }, calculatedPrice: { unitPrice: 49 }, cover: { media: { url: 'http://shop/v.jpg' } } } } }; },
  };
  return { ro: new ReadOnlyShopware(raw, createGuard()), calls };
}

test('Stream anlegen: Namen → IDs, lesbare Regel, Treffer und Beispiele vor der Freigabe', async () => {
  const { buildStreamChangeSet } = await import('../../../src/server/features/streams');
  const { ro, calls } = fakeShop();
  const cs = await buildStreamChangeSet(ro, { title: 'Neu', reason: 'Sortiment', streams: [
    { name: 'Wohnaccessoires bis 50 €', groups: [{ conditions: [{ field: 'category', names: ['Wohnaccessoires'] }, { field: 'price', max: 50 }] }] },
    { name: 'Kaputt', groups: [{ conditions: [{ field: 'category', names: ['Gibt es nicht'] }] }] },
  ] });
  assert.equal(cs.kind, 'product-streams');
  assert.equal(cs.items.length, 1);
  const it = cs.items[0];
  assert.equal(it.fieldLabel, 'Neuer Produktstream');
  assert.equal(it.after, 'Kategorie (inkl. Unterkategorien) = Wohnen › Wohnaccessoires UND Preis ≤ 50,00 € · 2 Treffer in „Storefront“');
  const p = it.afterRaw as { mode: string; id: string; rows: { parentId: string | null; field?: string | null; value?: string | null }[] };
  assert.equal(p.mode, 'create'); assert.equal(it.entityId, p.id);
  assert.equal(p.rows.find(r => r.field === 'categoriesRo.id')?.value, CAT);
  assert.equal(cs.assets?.[0].url, 'http://shop/v.jpg');
  assert.match(cs.skipped[0].reason, /Kategorie „Gibt es nicht“ nicht gefunden/);
  assert.equal(calls[0].path, `/_admin/product-stream-preview/${SC}`);
  assert.deepEqual((calls[0].body as { filter: FilterNode[] }).filter[0].queries?.[0].queries?.[0], { type: 'equalsAny', field: 'categoriesRo.id', value: CAT });
});

test('Stream ändern: alte Regel als Vorher, Warnung bei Verwendung, unveränderte Regel wird erkannt', async () => {
  const { buildStreamChangeSet } = await import('../../../src/server/features/streams');
  const oldRows = treeToRows([specToTree([{ conditions: [{ field: 'category', ids: [CAT] }] }])], ids).map(r => ({ ...r }));
  const stream = { id: STREAM, name: 'Wohnen', filters: oldRows, categories: [{ id: CAT, name: 'Wohnaccessoires', productAssignmentType: 'product_stream' }], productCrossSellings: [] };
  const { ro } = fakeShop({ 'product-stream': c => (c.ids?.includes(STREAM) ? [stream] : []) }, { total: 0 });
  const cs = await buildStreamChangeSet(ro, { title: 'Ändern', reason: 'günstiger', streams: [{ id: STREAM, name: 'Wohnen', groups: [{ conditions: [{ field: 'category', ids: [CAT] }, { field: 'price', max: 30 }] }] }] });
  const it = cs.items[0];
  assert.equal(it.fieldLabel, 'Regel');
  assert.equal(it.before, 'Kategorie (inkl. Unterkategorien) = Wohnen › Wohnaccessoires');
  assert.deepEqual(it.warn, ['Keine Treffer in „Storefront“', 'Wirkt sofort auf 1 Kategorie(n) und 0 Cross-Selling(s)']);
  await assert.rejects(buildStreamChangeSet(ro, { title: 'x', reason: 'x', streams: [{ id: STREAM, name: 'Wohnen', groups: [{ conditions: [{ field: 'category', ids: [CAT] }] }] }] }), /1 unverändert/);
});

test('Applier: Update löscht alte Filter und liefert exakte Rückgängig-Schritte (neue Filter löschen, alten Baum mit IDs neu)', async () => {
  const { applyStream } = await import('../../../src/server/features/streams');
  const oldRows = treeToRows([specToTree([{ conditions: [{ field: 'stock', min: 1 }] }])], ids);
  const newRows = treeToRows([specToTree([{ conditions: [{ field: 'stock', min: 5 }] }])], ids);
  const log: string[] = [];
  const sw = {
    get: async () => ({ id: STREAM, name: 'Lager', description: null, filters: oldRows.map(r => ({ ...r, productStreamId: STREAM, createdAt: 'x' })) }),
    req: async (m: string, p: string) => { log.push(`${m} ${p}`); },
    update: async (e: string, id: string, d: { filters: unknown[] }) => { log.push(`PATCH ${e}/${id} ${d.filters.length}`); },
  } as unknown as Parameters<typeof applyStream>[0];
  const undo = await applyStream(sw, { mode: 'update', id: STREAM, name: 'Lager ab 5', description: null, rows: newRows });
  assert.deepEqual(log, [`DELETE /product-stream-filter/${oldRows[0].id}`, `PATCH product-stream/${STREAM} ${newRows.length}`]);
  assert.deepEqual(undo[0], { op: 'patch', entity: 'product-stream', id: STREAM, data: { name: 'Lager', description: null, filters: oldRows } });
  assert.deepEqual(undo[1], { op: 'req', method: 'DELETE', path: `/product-stream-filter/${newRows[0].id}`, entity: 'product-stream-filter', id: newRows[0].id });
  const created = await applyStream({ create: async () => {} } as unknown as Parameters<typeof applyStream>[0], { mode: 'create', id: STREAM, name: 'x', description: null, rows: newRows });
  assert.deepEqual(created, [{ op: 'delete', entity: 'product-stream', id: STREAM }]);
});

test('Zuordnung: Kategorie dynamisch (Warnung manuelle Produkte), Cross-Selling je Produkt, Undo-Payload', async () => {
  const { buildStreamAssignmentChangeSet, applyAssignment } = await import('../../../src/server/features/streams');
  const P1 = '11'.repeat(16), P2 = '22'.repeat(16);
  const { ro } = fakeShop({
    'product-stream': c => (c.ids?.includes(STREAM) ? [{ id: STREAM, name: 'Sale', filters: treeToRows([specToTree([{ conditions: [{ field: 'onSale' }] }])], ids) }] : []),
    product: c => [{ id: P1, productNumber: 'A', name: 'Alpha' }, { id: P2, productNumber: 'B', name: 'Beta' }].filter(p => !c.ids || c.ids.includes(p.id)),
    'product-cross-selling': () => [{ id: 'x1', productId: P1, name: 'Zubehör', position: 1, type: 'productList' }, { id: 'x2', productId: P2, name: 'Sale', position: 1, type: 'productStream', productStreamId: STREAM }],
  });
  const cs = await buildStreamAssignmentChangeSet(ro, { title: 'Sale', reason: 'dyn', streamId: STREAM, categoryIds: [CAT], productIds: [P1, P2], crossSelling: { name: 'Auch reduziert' } });
  assert.equal(cs.kind, 'product-stream-assignment');
  assert.deepEqual(cs.items.map(i => i.id), ['info', `cat:${CAT}`, `xs:${P1}`]);
  assert.equal(cs.unchanged, 1);
  assert.equal(cs.items[0].after, 'Im Angebot (mit Streichpreis) · 2 Treffer in „Storefront“');
  const cat = cs.items[1];
  assert.equal(cat.before, 'manuell (4 Produkte)'); assert.equal(cat.after, 'dynamisch: Produktstream „Sale“ (2 Treffer)');
  assert.deepEqual(cat.warn, ['4 manuell zugeordnete Produkte werden nicht mehr angezeigt (bleiben gespeichert)']);
  const xs = cs.items[2].afterRaw as { position: number; limit: number; sortBy: string; active: boolean };
  assert.deepEqual([xs.position, xs.limit, xs.sortBy, xs.active], [2, 24, 'name', true]);
  await assert.rejects(buildStreamAssignmentChangeSet(ro, { title: 'x', reason: 'x', streamId: STREAM, productIds: [P1] }), /crossSelling\.name/);
  await assert.rejects(buildStreamAssignmentChangeSet(ro, { title: 'x', reason: 'x', streamId: null, productIds: [P1] }), /braucht einen streamId/);

  const writes: unknown[] = [];
  const sw = { get: async () => ({ id: CAT, productAssignmentType: 'product', productStreamId: null }), update: async (...a: unknown[]) => { writes.push(a); }, create: async (...a: unknown[]) => { writes.push(a); } } as unknown as Parameters<typeof applyAssignment>[0];
  assert.deepEqual(await applyAssignment(sw, cat.afterRaw as never), { op: 'patch', entity: 'category', id: CAT, data: { productAssignmentType: 'product', productStreamId: null } });
  assert.deepEqual(writes[0], ['category', CAT, { productAssignmentType: 'product_stream', productStreamId: STREAM }]);
  const u = await applyAssignment(sw, cs.items[2].afterRaw as never);
  assert.deepEqual(u, { op: 'delete', entity: 'product-cross-selling', id: (cs.items[2].afterRaw as { id: string }).id });
});

test('Stale-Write-Guard: Stream bzw. Produktzuordnung inzwischen geändert → nicht überschrieben; gleicher Stand (auch mit neuen Filter-IDs) schreibt', async () => {
  const { applyStream, applyAssignment, buildStreamChangeSet } = await import('../../../src/server/features/streams');
  type Payload = Parameters<typeof applyStream>[1];
  const oldRows = treeToRows([specToTree([{ conditions: [{ field: 'stock', min: 1 }] }])], ids);
  const { ro } = fakeShop({ 'product-stream': c => (c.ids?.includes(STREAM) ? [{ id: STREAM, name: 'Lager', filters: oldRows }] : []) });
  const cs = await buildStreamChangeSet(ro, { title: 't', reason: 'r', streams: [{ id: STREAM, name: 'Lager ab 5', groups: [{ conditions: [{ field: 'stock', min: 5 }] }] }] });
  const before = cs.items[0].beforeRaw, p = cs.items[0].afterRaw as Payload;
  assert.deepEqual(before, { name: 'Lager', description: null, tree: rowsToTree(oldRows) }, 'Builder merkt Name, Beschreibung und Regelbaum');
  const log: string[] = [];
  const sw = (filters: unknown[], name = 'Lager') => ({
    get: async () => ({ id: STREAM, name, description: null, translated: { name }, filters: filters.map(r => ({ ...(r as object), productStreamId: STREAM })) }),
    req: async (m: string, path: string) => { log.push(`${m} ${path}`); }, update: async (e: string, id: string) => { log.push(`PATCH ${e}/${id}`); },
  }) as unknown as Parameters<typeof applyStream>[0];
  // Admin hat inzwischen die Regel bzw. den Namen geändert → nichts gelöscht, nichts geschrieben
  await assert.rejects(applyStream(sw(treeToRows([specToTree([{ conditions: [{ field: 'stock', min: 3 }] }])], ids)), p, before), /^Error: Produktstream: inzwischen geändert, bitte neu vorschlagen$/);
  await assert.rejects(applyStream(sw(oldRows, 'Lager (umbenannt)'), p, before), /inzwischen geändert/);
  assert.equal(log.length, 0, 'weder gelöscht noch geschrieben');
  // gleiche Regel, nur neu gespeichert (andere Filter-IDs): keine Änderung → schreibt; Altbestand ohne beforeRaw ebenso
  await applyStream(sw(treeToRows(rowsToTree(oldRows), ids)), p, before);
  await applyStream(sw(treeToRows([specToTree([{ conditions: [{ field: 'stock', min: 3 }] }])], ids)), p, undefined);
  assert.equal(log.filter(l => l.startsWith('PATCH product-stream/')).length, 2);
  // Kategorie-Zuordnung: inzwischen auf einen anderen Stream gestellt
  const writes: unknown[] = [];
  const cat = { get: async () => ({ id: CAT, productAssignmentType: 'product_stream', productStreamId: 'x'.repeat(32) }), update: async (...a: unknown[]) => { writes.push(a); } } as unknown as Parameters<typeof applyAssignment>[0];
  const payload = { kind: 'category', categoryId: CAT, productAssignmentType: 'product_stream', productStreamId: STREAM } as const;
  await assert.rejects(applyAssignment(cat, payload, { productAssignmentType: 'product', productStreamId: null }), /Produktzuordnung: inzwischen geändert, bitte neu vorschlagen/);
  assert.deepEqual(writes, []);
  const u = await applyAssignment(cat, payload, { productAssignmentType: 'product_stream', productStreamId: 'x'.repeat(32) });
  assert.deepEqual(u, { op: 'patch', entity: 'category', id: CAT, data: { productAssignmentType: 'product_stream', productStreamId: 'x'.repeat(32) } });
  assert.equal(writes.length, 1);
});

test('Policy: Stream-Vorschau ist der einzige erlaubte POST, Body wird wie eine Produktsuche geprüft', () => {
  const g = createGuard(), path = `/_admin/product-stream-preview/${SC}`;
  assert.equal(g.checkReq('POST', path, { filter: [], limit: 1, associations: { cover: { associations: { media: {} } } } }), 'product');
  assert.throws(() => g.checkReq('POST', path, { filter: [{ type: 'equals', field: 'orderLineItems.order.orderCustomer.email', value: 'x' }] }), /Filter\/Sortierung/);
  assert.throws(() => g.checkReq('POST', path, { associations: { orderLineItems: {} } }), /Beziehung/);
  assert.throws(() => g.checkReq('POST', path, { fields: ['id'] }), /nicht erlaubt/);
  assert.throws(() => g.checkReq('PATCH', path, {}), /nicht erlaubt/);
  assert.throws(() => g.checkReq('POST', '/_action/sync', {}), /nicht erlaubt/);
  assert.throws(() => g.checkReq('POST', `/_admin/product-stream-preview/${SC}/x`, {}), /nicht erlaubt/);
  assert.equal(g.checkReq('GET', '/_info/version'), null);
  assert.doesNotThrow(() => g.checkSearch('product-stream', { associations: { filters: {}, categories: {}, productCrossSellings: { associations: { product: {} } } } }));
});

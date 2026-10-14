import 'server-only';
// Product data: properties, categories, manufacturers, tags, delivery time, dimensions, tax, visibility, purchase quantities, cross-selling, single and in bulk.
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { ChangeItem, ChangeSet } from '@/lib/protocol';
import { MAX_ITEMS } from '../changes';
import { HEX32, newId, type ShopReader, type SwEntity } from '../shopware';
import type { AssocTree } from '../policy';
import { fail, guard, nextOffsetOf, ok, pageOf, type AnyTool } from '../tool-kit';
import type { Session } from '../sessions';
import type { Feature } from './types';
import { KIND_PRODUCT_DATA, NewRegistry, nameOf, planProduct, productFilter, productLabel, type Catalog, type DataOps, type ProductFilter, type PropIn } from './product-data-plan';
import { neededCreates, type ProductDataPayload } from './product-data-apply'; // also registers the applier

export const PRODUCT_ASSOC: AssocTree = {
  properties: { associations: { group: {} } }, categories: {}, tags: {}, manufacturer: {}, deliveryTime: {}, tax: {}, visibilities: {},
  crossSellings: { associations: { assignedProducts: {} } },
};
const VIS_NAME: Record<number, string> = { 30: 'all', 20: 'search', 10: 'link' };

export interface DataTarget extends DataOps { productIds?: string[]; filter?: ProductFilter }
export interface ProductDataArgs { title: string; reason: string; changes: DataTarget[] }

const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const uniq = <T>(xs: (T | null | undefined)[]) => [...new Set(xs.filter((x): x is T => x != null && x !== ''))];

/** Records by ID and/or name (name: case-insensitive, matched later in the plan) */
async function byIdsOrNames(ro: ShopReader, entity: string, refs: string[], extra: Record<string, unknown>[] = [], assoc?: AssocTree): Promise<SwEntity[]> {
  const ids = uniq(refs.filter(r => HEX32.test(r))), names = uniq(refs.filter(r => !HEX32.test(r)).map(r => r.trim()));
  if (!ids.length && !names.length) return [];
  const or = [...(ids.length ? [{ type: 'equalsAny', field: 'id', value: ids }] : []), ...(names.length ? [{ type: 'equalsAny', field: 'name', value: names }] : [])];
  return (await ro.search(entity, { limit: 500, filter: [...extra, { type: 'multi', operator: 'OR', queries: or }], ...(assoc ? { associations: assoc } : {}) })).data;
}
const byIds = async (ro: ShopReader, entity: string, ids: string[], assoc?: AssocTree) => {
  const out: SwEntity[] = [];
  for (const part of chunks(uniq(ids).filter(i => HEX32.test(i)), 100)) out.push(...(await ro.search(entity, { ids: part, limit: part.length, ...(assoc ? { associations: assoc } : {}) })).data);
  return out;
};
const toMap = (xs: SwEntity[]) => Object.fromEntries(xs.map(x => [x.id, x]));

/** Loads everything the operations reference (properties, manufacturers, tags, categories, products, streams …) */
export async function loadCatalog(ro: ShopReader, opsList: DataOps[], productIds: string[] = []): Promise<Catalog> {
  const props: PropIn[] = opsList.flatMap(o => [...(o.properties?.add ?? []), ...(o.properties?.remove ?? [])]);
  const named = props.map(p => (typeof p === 'string' ? (HEX32.test(p) ? null : p.match(/^([^:]+):\s*(.+)$/)) : [null, p.group, p.option])).filter(Boolean).map(m => ({ group: String(m![1]).trim(), option: String(m![2]).trim() }));
  const optIds = props.filter((p): p is string => typeof p === 'string' && HEX32.test(p));
  const groups = await byIdsOrNames(ro, 'property-group', named.map(n => n.group));
  const groupOpts = groups.length && named.length ? await byIdsOrNames(ro, 'property-group-option', named.map(n => n.option), [{ type: 'equalsAny', field: 'groupId', value: groups.map(g => g.id) }]) : [];
  for (const g of groups) g.options = groupOpts.filter(o => o.groupId === g.id);
  const options = toMap([...(await byIds(ro, 'property-group-option', optIds, { group: {} })), ...groupOpts.map(o => ({ ...o, group: groups.find(g => g.id === o.groupId) }))]);
  const crossIds = opsList.flatMap(o => (o.crossSellings ?? []).flatMap(c => [...(c.productIds ?? []), ...(c.addProductIds ?? []), ...(c.removeProductIds ?? [])]));
  const any = (f: (o: DataOps) => unknown) => opsList.some(o => f(o) !== undefined);
  return {
    groups, options,
    manufacturers: await byIdsOrNames(ro, 'product-manufacturer', opsList.map(o => o.manufacturer).filter((m): m is string => typeof m === 'string')),
    tags: await byIdsOrNames(ro, 'tag', opsList.flatMap(o => [...(o.tags?.add ?? []), ...(o.tags?.remove ?? [])].map(String))),
    deliveryTimes: any(o => o.deliveryTime) ? (await ro.search('delivery-time', { limit: 100 })).data : [],
    taxes: any(o => o.taxRate) ? (await ro.search('tax', { limit: 100 })).data : [],
    channels: any(o => o.visibility) ? await ro.salesChannels() : [],
    categories: toMap(await byIds(ro, 'category', opsList.flatMap(o => o.categories?.add ?? []))),
    products: toMap(await byIds(ro, 'product', [...crossIds, ...productIds])),
    streams: toMap(await byIds(ro, 'product-stream', opsList.flatMap(o => (o.crossSellings ?? []).map(c => c.productStreamId ?? '')))),
  };
}

/** Target products of an entry: productIds and/or filter (at most MAX_ITEMS) */
async function targetIds(ro: ShopReader, t: DataTarget): Promise<string[]> {
  if (!t.productIds?.length && !t.filter) throw new Error('Je Eintrag productIds oder filter angeben');
  const ids = [...(t.productIds ?? [])];
  if (t.filter) {
    const r = await ro.search('product', { ...productFilter(t.filter), limit: MAX_ITEMS, 'total-count-mode': 1, includes: { product: ['id'] } }); // IDs only, the products are loaded with associations below
    if ((r.total ?? r.data.length) > MAX_ITEMS) throw new Error(`Filter trifft ${r.total} Produkte, höchstens ${MAX_ITEMS} pro Änderungsset. Filter verfeinern oder mit productIds in Sets aufteilen.`);
    ids.push(...r.data.map(p => p.id));
  }
  return uniq(ids);
}

export async function buildProductDataChangeSet(ro: ShopReader, { title, reason, changes }: ProductDataArgs, genId: () => string = newId): Promise<{ cs: ChangeSet; payload: ProductDataPayload }> {
  if (!changes?.length) throw new Error('changes ist leer');
  const pairs: { pid: string; ops: DataOps }[] = [];
  for (const t of changes) { const ops: DataOps = { ...t }; delete (ops as DataTarget).productIds; delete (ops as DataTarget).filter; for (const pid of await targetIds(ro, t)) pairs.push({ pid, ops }); }
  const pids = uniq(pairs.map(p => p.pid));
  if (!pids.length) throw new Error('Keine Produkte gefunden (productIds/filter prüfen)');
  if (pids.length > MAX_ITEMS) throw new Error(`Maximal ${MAX_ITEMS} Produkte pro Änderungsset, bitte aufteilen.`);
  const products = toMap(await byIds(ro, 'product', pids, PRODUCT_ASSOC));
  // names of the products currently assigned in cross-selling (for the readable before value)
  const assigned = pairs.filter(p => p.ops.crossSellings?.length).flatMap(p => (products[p.pid]?.crossSellings ?? []).flatMap((c: SwEntity) => (c.assignedProducts ?? []).map((a: SwEntity) => a.productId as string)));
  const cat = await loadCatalog(ro, pairs.map(p => p.ops), assigned);
  const reg = new NewRegistry(genId), items: ChangeItem[] = [], skipped: ChangeSet['skipped'] = []; let unchanged = 0;
  for (const { pid, ops } of pairs) {
    const cur = products[pid];
    if (!cur) { skipped.push({ id: pid, reason: `Produkt ${pid} nicht gefunden` }); continue; }
    const r = planProduct(cur, ops, cat, reg, genId);
    for (const it of r.items) {
      if (items.some(x => x.id === it.id)) skipped.push({ id: pid, reason: `${productLabel(cur)} · ${it.fieldLabel}: mehrfach angegeben, nur der erste Eintrag zählt` });
      else items.push(it);
    }
    skipped.push(...r.skipped); unchanged += r.unchanged;
  }
  if (!items.length) throw new Error(`Keine Änderung nötig bzw. nichts anwendbar (${unchanged} unverändert, ${skipped.length} übersprungen${skipped.length ? `: ${skipped.slice(0, 4).map(s => s.reason).join('; ')}` : ''})`);
  return {
    cs: { id: newId(), kind: KIND_PRODUCT_DATA, entity: 'product', noun: { one: 'Produkt', many: 'Produkte' }, applyLabel: 'Stammdaten übernehmen', title, reason, items, skipped, unchanged, atomic: false },
    payload: { creates: neededCreates(items, reg.list) }, // only creations an item uses (incl. the group of a new option)
  };
}

// ---- Read views ----
export function productDetails(p: SwEntity, channels: SwEntity[]) {
  const groups = new Map<string, { groupId: string; group: string; options: { id: string; name: string }[] }>();
  for (const o of (p.properties ?? []) as SwEntity[]) { const g = groups.get(o.groupId) ?? { groupId: o.groupId as string, group: nameOf(o.group), options: [] as { id: string; name: string }[] }; g.options.push({ id: o.id, name: nameOf(o) }); groups.set(o.groupId, g); }
  return {
    id: p.id, number: p.productNumber, name: p.translated?.name ?? p.name, parentId: p.parentId ?? null, variants: p.childCount ?? 0, active: p.active,
    manufacturer: p.manufacturer ? { id: p.manufacturer.id, name: nameOf(p.manufacturer) } : null,
    properties: [...groups.values()],
    categories: (p.categories ?? []).map((c: SwEntity) => ({ id: c.id, path: c.translated?.breadcrumb?.slice(1).join(' > ') || nameOf(c) })),
    tags: (p.tags ?? []).map((t: SwEntity) => ({ id: t.id, name: t.name })),
    deliveryTime: p.deliveryTime ? { id: p.deliveryTime.id, name: nameOf(p.deliveryTime) } : null,
    tax: p.tax ? { id: p.tax.id, rate: p.tax.taxRate, name: p.tax.name } : null,
    priceGross: p.price?.[0]?.gross ?? null, priceNet: p.price?.[0]?.net ?? null,
    weightKg: p.weight ?? null, widthMm: p.width ?? null, heightMm: p.height ?? null, lengthMm: p.length ?? null,
    shippingFree: !!p.shippingFree, minPurchase: p.minPurchase ?? 1, purchaseSteps: p.purchaseSteps ?? 1, maxPurchase: p.maxPurchase ?? null,
    markAsTopseller: !!p.markAsTopseller, releaseDate: p.releaseDate ? String(p.releaseDate).slice(0, 10) : null,
    visibilities: (p.visibilities ?? []).map((v: SwEntity) => ({ salesChannelId: v.salesChannelId, salesChannel: nameOf(channels.find(c => c.id === v.salesChannelId)), visibility: VIS_NAME[v.visibility] ?? v.visibility })),
    crossSellings: [...(p.crossSellings ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((c: SwEntity) => ({
      id: c.id, name: nameOf(c), type: c.type, active: c.active, position: c.position, limit: c.limit, sortBy: c.sortBy, sortDirection: c.sortDirection, productStreamId: c.productStreamId ?? null,
      products: [...(c.assignedProducts ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((a: SwEntity) => ({ id: a.productId, name: a.product ? nameOf(a.product) : undefined, number: a.product?.productNumber })),
    })),
  };
}

// ---- Tools ----
const filterSchema = z.object({
  categoryId: z.string().optional(), manufacturerId: z.string().optional(), tagId: z.string().optional(), propertyOptionId: z.string().optional(),
  deliveryTimeId: z.string().optional(), salesChannelId: z.string().optional().describe('nur Produkte, die in diesem Verkaufskanal sichtbar sind'),
  taxRate: z.number().optional(), term: z.string().optional(), active: z.boolean().optional(), productNumbers: z.array(z.string()).optional(),
  includeVariants: z.boolean().optional().describe('Standard false = nur Hauptprodukte'),
  missing: z.array(z.enum(['manufacturer', 'deliveryTime', 'weight', 'dimensions', 'properties', 'categories', 'tags', 'visibility', 'crossSelling'])).optional().describe('nur Produkte, denen das fehlt'),
});
const listRef = z.object({ add: z.array(z.string()).optional(), remove: z.array(z.string()).optional() });
const propRef = z.union([z.string(), z.object({ group: z.string().describe('Gruppe: id oder Name'), option: z.string().describe('Wert: id oder Name') })]);
const crossSchema = z.object({
  action: z.enum(['create', 'update', 'delete']),
  id: z.string().optional().describe('update/delete: id des Cross-Sellings'), match: z.string().optional().describe('update/delete: bisheriger Name statt id (für Masse)'),
  name: z.string().optional().describe('create: Name (Pflicht); update: neuer Name'), type: z.enum(['productList', 'productStream']).optional().describe('Standard productList'),
  productIds: z.array(z.string()).optional().describe('productList: VOLLSTÄNDIGE Liste in Reihenfolge (ersetzt die bisherige)'),
  addProductIds: z.array(z.string()).optional().describe('update: hinten anhängen'), removeProductIds: z.array(z.string()).optional().describe('update: entfernen'),
  productStreamId: z.string().optional().describe('productStream: id eines BESTEHENDEN Produktstreams'),
  position: z.number().int().optional(), active: z.boolean().optional(), limit: z.number().int().optional(),
  sortBy: z.enum(['name', 'price', 'releaseDate']).optional(), sortDirection: z.enum(['ASC', 'DESC']).optional(),
});
const opsShape = {
  properties: z.object({ add: z.array(propRef).optional(), remove: z.array(propRef).optional() }).optional()
    .describe('Eigenschaften: optionId oder {group, option} (Namen). Nicht vorhandene Werte/Gruppen werden NEU angelegt (im Vorschlag als „neu“ markiert)'),
  categories: listRef.optional().describe('Kategorie-IDs hinzufügen/entfernen'),
  manufacturer: z.string().nullable().optional().describe('id oder Name (unbekannter Name → wird neu angelegt); null = entfernen'),
  tags: listRef.optional().describe('Tag-Namen oder -IDs; unbekannte Namen werden neu angelegt'),
  deliveryTime: z.string().nullable().optional().describe('id oder Name einer bestehenden Lieferzeit; null = entfernen'),
  weight: z.number().nullable().optional().describe('kg'), width: z.number().nullable().optional().describe('mm'), height: z.number().nullable().optional().describe('mm'), length: z.number().nullable().optional().describe('mm'),
  taxRate: z.number().optional().describe('Steuersatz in % (muss im Shop existieren); Brutto bleibt, Netto wird neu berechnet'),
  visibility: z.object({ add: z.array(z.object({ salesChannel: z.string().describe('id oder Name'), visibility: z.enum(['all', 'search', 'link']).optional().describe('Standard all') })).optional(), remove: z.array(z.string()).optional() }).optional()
    .describe('Sichtbarkeit je Verkaufskanal'),
  shippingFree: z.boolean().optional(), markAsTopseller: z.boolean().optional(),
  minPurchase: z.number().int().optional(), purchaseSteps: z.number().int().optional(), maxPurchase: z.number().int().nullable().optional().describe('null = unbegrenzt'),
  releaseDate: z.string().nullable().optional().describe('JJJJ-MM-TT; null = entfernen'),
  crossSellings: z.array(crossSchema).optional(),
};

const pageArgs = { limit: z.number().optional().describe('Standard 50, max 100'), offset: z.number().optional().describe('Vielfaches von limit (nextOffset der vorigen Seite)') };
const page = (limit?: number, offset?: number) => pageOf(offset, Math.min(Math.max(limit ?? 50, 1), 100));
/** Paging info of the response: offset actually read (rounded → note), nextOffset */
const paged = (pg: ReturnType<typeof page>, r: { data: unknown[]; total?: number }) => ({ total: r.total, returned: r.data.length, offset: pg.offset, ...(pg.note ? { note: pg.note } : {}), nextOffset: nextOffsetOf(pg.offset, r.data.length, pg.limit, r.total) });
const termFilter = (term?: string) => (term ? [{ type: 'contains', field: 'name', value: term }] : []);

export const PRODUCT_DATA_TOOLS = ['list_property_groups', 'list_manufacturers', 'list_tags', 'list_delivery_times', 'list_taxes', 'get_product_details', 'find_products_by_data', 'propose_product_data'];

function tools(session: Session): AnyTool[] {
  const { sw } = session;
  return [
    tool('list_property_groups', 'Eigenschaftsgruppen (z. B. Farbe, Material) mit ihren Werten und IDs LESEN. Ohne groupId: Gruppen paginiert, je Gruppe bis zu optionLimit Werte (optionsTruncated = es gibt mehr). Mit groupId: alle Werte dieser einen Gruppe paginiert. Ändert nichts.',
      { term: z.string().optional().describe('Gruppenname enthält …'), groupId: z.string().optional(), optionTerm: z.string().optional().describe('mit groupId: Wertname enthält …'), optionLimit: z.number().optional().describe('Standard 30'), ...pageArgs },
      guard(async a => {
        if (a.groupId) {
          const pg = page(a.limit, a.offset), r = await sw.search('property-group-option', { limit: pg.limit, page: pg.page, 'total-count-mode': 1, filter: [{ type: 'equals', field: 'groupId', value: a.groupId }, ...termFilter(a.optionTerm)], sort: [{ field: 'name', order: 'ASC' }] });
          return ok({ ...paged(pg, r), options: r.data.map(o => ({ id: o.id, name: nameOf(o) })) });
        }
        const ol = Math.min(Math.max(a.optionLimit ?? 30, 1), 100), pg = page(a.limit, a.offset);
        const r = await sw.search('property-group', { limit: pg.limit, page: pg.page, 'total-count-mode': 1, filter: termFilter(a.term), sort: [{ field: 'name', order: 'ASC' }], associations: { options: { limit: ol + 1, sort: [{ field: 'name', order: 'ASC' }] } } });
        return ok({ ...paged(pg, r), groups: r.data.map(g => ({ id: g.id, name: nameOf(g), filterable: g.filterable, options: (g.options ?? []).slice(0, ol).map((o: SwEntity) => ({ id: o.id, name: nameOf(o) })), ...((g.options ?? []).length > ol ? { optionsTruncated: true } : {}) })) });
      })),

    tool('list_manufacturers', 'Hersteller (Marken) mit IDs LESEN, paginiert, optional nach Name gefiltert. Ändert nichts.',
      { term: z.string().optional(), ...pageArgs }, guard(async a => {
        const pg = page(a.limit, a.offset), r = await sw.search('product-manufacturer', { limit: pg.limit, page: pg.page, 'total-count-mode': 1, filter: termFilter(a.term), sort: [{ field: 'name', order: 'ASC' }] });
        return ok({ ...paged(pg, r), manufacturers: r.data.map(m => ({ id: m.id, name: nameOf(m), link: m.link ?? undefined })) });
      })),

    tool('list_tags', 'Tags mit IDs LESEN, paginiert, optional nach Name gefiltert. Ändert nichts.',
      { term: z.string().optional(), ...pageArgs }, guard(async a => {
        const pg = page(a.limit, a.offset), r = await sw.search('tag', { limit: pg.limit, page: pg.page, 'total-count-mode': 1, filter: termFilter(a.term), sort: [{ field: 'name', order: 'ASC' }] });
        return ok({ ...paged(pg, r), tags: r.data.map(t => ({ id: t.id, name: t.name })) });
      })),

    tool('list_delivery_times', 'Alle Lieferzeiten des Shops mit IDs LESEN (Name, min/max, Einheit). Ändert nichts; neue Lieferzeiten legt Lotse nicht an.', {}, guard(async () => {
      const r = await sw.search('delivery-time', { limit: 100 });
      return ok(r.data.map(d => ({ id: d.id, name: nameOf(d), min: d.min, max: d.max, unit: d.unit })));
    })),

    tool('list_taxes', 'Alle Steuersätze des Shops LESEN (id, Name, Satz in %). Ändert nichts.', {}, guard(async () => {
      const r = await sw.search('tax', { limit: 100, sort: [{ field: 'taxRate', order: 'DESC' }] });
      return ok(r.data.map(t => ({ id: t.id, name: t.name, taxRate: t.taxRate })));
    })),

    tool('get_product_details', 'Alle Stammdaten von 1 bis 25 Produkten LESEN: Eigenschaften (je Gruppe mit IDs), Kategorien, Hersteller, Tags, Lieferzeit, Steuersatz und Preis, Gewicht/Maße, Versandkostenfrei, Mindest-/Maximalabnahme, Staffelung, Topseller, Erscheinungsdatum, Sichtbarkeit je Verkaufskanal, Cross-Sellings (mit Produkten). Ändert nichts. Für Texte/Bilder: get_product.',
      { ids: z.array(z.string()).min(1).max(25) }, guard(async ({ ids }) => {
        const rows = await byIds(sw, 'product', ids, { ...PRODUCT_ASSOC, crossSellings: { associations: { assignedProducts: { associations: { product: {} } } } } });
        if (!rows.length) return fail('Kein Produkt gefunden');
        const channels = await sw.salesChannels();
        return ok({ products: rows.map(p => productDetails(p, channels)), ...(rows.length < ids.length ? { notFound: ids.filter(i => !rows.some(r => r.id === i)) } : {}) });
      })),

    tool('find_products_by_data', 'Produkte nach Stammdaten FINDEN (für Massenänderungen): Kategorie, Hersteller, Tag, Eigenschaftswert, Lieferzeit, Verkaufskanal, Steuersatz, aktiv, Produktnummern, Freitext, und „missing“ (z. B. ohne Hersteller/Lieferzeit/Gewicht/Eigenschaften/Kategorie). Liefert total + Seite mit Kurzinfos; mit offset blättern. Ändert nichts.',
      { ...filterSchema.shape, ...pageArgs }, guard(async a => {
        const { limit, offset, ...f } = a, pg = page(limit, offset);
        const r = await sw.search('product', { ...productFilter(f), limit: pg.limit, page: pg.page, 'total-count-mode': 1, sort: [{ field: 'productNumber', order: 'ASC' }], associations: { manufacturer: {}, deliveryTime: {}, tax: {}, tags: {}, properties: { associations: { group: {} } }, categories: {} } });
        return ok({ ...paged(pg, r), products: r.data.map(p => ({
          id: p.id, number: p.productNumber, name: p.translated?.name ?? p.name, active: p.active, manufacturer: p.manufacturer ? nameOf(p.manufacturer) : null,
          deliveryTime: p.deliveryTime ? nameOf(p.deliveryTime) : null, taxRate: p.tax?.taxRate ?? null, weightKg: p.weight ?? null,
          properties: (p.properties ?? []).map((o: SwEntity) => `${nameOf(o.group)}: ${nameOf(o)}`), categories: (p.categories ?? []).map(nameOf), tags: (p.tags ?? []).map((t: SwEntity) => t.name),
        })) });
      })),

    tool('propose_product_data', `SCHLÄGT Stammdaten-Änderungen für 1 bis ${MAX_ITEMS} Produkte vor. Es wird NICHTS geschrieben: Der Nutzer sieht je Produkt und Bereich einen lesbaren Alt→Neu-Vergleich (z. B. „Farbe: Sand“ → „Farbe: Sand, Taupe“), wählt aus und gibt frei; erst dann schreibt der Server (mit Rückgängig). Der Aufruf wartet auf die Entscheidung.
changes = Liste von Einträgen; jeder Eintrag wählt Produkte per productIds und/oder filter (wie find_products_by_data) und nennt die Operationen, die für ALLE diese Produkte gelten. Für produktindividuelle Werte je Produkt einen eigenen Eintrag.
Operationen: properties add/remove, categories add/remove, manufacturer, tags add/remove, deliveryTime, weight (kg) / width / height / length (mm), taxRate, visibility add/remove, shippingFree, markAsTopseller, minPurchase, purchaseSteps, maxPurchase, releaseDate, crossSellings (create/update/delete, Typ productList mit Produkten in Reihenfolge oder productStream mit bestehender Stream-ID).
Nicht enthalten: Preise/Bestand (einzeln propose_product_changes, in Masse propose_bulk_product_change), Texte/SEO (propose_product_changes), Bilder (propose_product_images), Varianten anlegen (propose_variants), neue Lieferzeiten/Steuersätze/Kategorien/Produktstreams anlegen.`,
      { title: z.string().describe('Kurzer Titel, z. B. „Farbe Taupe für 12 Vasen“'), reason: z.string().describe('Absicht/Regel in 1 bis 2 Sätzen'),
        changes: z.array(z.object({ productIds: z.array(z.string()).optional(), filter: filterSchema.optional(), ...opsShape })).min(1) },
      guard(async a => {
        const { cs, payload } = await buildProductDataChangeSet(sw, a as ProductDataArgs);
        return ok(await session.requestChange(cs, payload));
      })),
  ] as AnyTool[];
}

export const productData: Feature = { key: 'product-data', platforms: ['shopware'], toolNames: PRODUCT_DATA_TOOLS, tools };

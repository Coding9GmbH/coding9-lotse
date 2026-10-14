import 'server-only';
// Product streams (dynamic product groups): read, check matches, create/change and assign to categories/cross-sellings.
// Reading via session.sw (incl. the stream preview endpoint), writing only via change set after approval.
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { ChangeAsset, ChangeItem, ChangeSet, UndoOp } from '@/lib/protocol';
import { applyEach, assertFresh, errMsg, MAX_ITEMS, pool, registerApplier } from '../changes';
import { newId, type Shopware, type ShopReader, type SwEntity } from '../shopware';
import type { Session } from '../sessions';
import { ok, fail, guard, type AnyTool } from '../tool-kit';
import type { Feature } from './types';
import { COND_FIELDS, collectIds, renderRule, rowsToTree, sameTree, specToTree, treeToRows, treeToSpec, type CondSpec, type FilterNode, type FilterRow, type GroupSpec, type IdKind } from './streams-rules';

export const MAX_STREAMS = 20;
const nameOf = (e: SwEntity | null | undefined) => String(e?.translated?.name ?? e?.name ?? '');
const eur = (v: number) => `${v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const catPath = (c: SwEntity) => { const b = c.translated?.breadcrumb as string[] | undefined; return b && b.length > 1 ? b.slice(1).join(' › ') : nameOf(c); };
const prodLabel = (p: SwEntity) => `${nameOf(p) || p.productNumber}${p.productNumber ? ` (${p.productNumber})` : ''}`;
const hits = (n: number) => `${n} Treffer`;

const KIND: Record<IdKind, { entity: string; label: string; crit?: Record<string, unknown> }> = {
  category: { entity: 'category', label: 'Kategorie' }, manufacturer: { entity: 'product-manufacturer', label: 'Hersteller' },
  property: { entity: 'property-group-option', label: 'Eigenschaftswert', crit: { associations: { group: {} } } }, tag: { entity: 'tag', label: 'Tag' }, product: { entity: 'product', label: 'Produkt' },
};
const display = (k: IdKind, e: SwEntity) => (k === 'category' ? catPath(e) : k === 'property' ? `${nameOf(e.group)}: ${nameOf(e)}` : k === 'product' ? prodLabel(e) : nameOf(e));

/** IDs from filter trees → display names (one query per kind) */
export async function lookupNames(ro: ShopReader, trees: FilterNode[][]): Promise<Record<string, string>> {
  const acc = collectIds([]); for (const t of trees) collectIds(t, acc);
  const names: Record<string, string> = {};
  await Promise.all((Object.keys(acc) as IdKind[]).map(async k => {
    const ids = [...acc[k]].slice(0, 500); if (!ids.length) return;
    for (const e of (await ro.search(KIND[k].entity, { ids, limit: ids.length, ...KIND[k].crit })).data) names[e.id] = display(k, e);
  }));
  return names;
}

/** Names in conditions → IDs (categories unique, otherwise all matches with a note); unknown IDs/names → error with suggestions */
export async function resolveGroups(ro: ShopReader, groups: GroupSpec[]): Promise<{ groups: GroupSpec[]; names: Record<string, string>; notes: string[] }> {
  const names: Record<string, string> = {}, notes: string[] = [];
  const out: GroupSpec[] = [];
  for (const g of groups ?? []) {
    const conds: CondSpec[] = [];
    for (const c of g.conditions ?? []) {
      const k = (['category', 'manufacturer', 'property', 'tag'] as const).find(x => x === c.field);
      if (!k) { conds.push(c); continue; }
      const { entity, label, crit } = KIND[k], ids = new Set<string>();
      if (!c.ids?.length && !c.names?.length) throw new Error(`${label}: ids oder names angeben`);
      if (c.ids?.length) {
        const found = (await ro.search(entity, { ids: c.ids, limit: c.ids.length, ...crit })).data;
        const miss = c.ids.filter(id => !found.some(f => f.id === id));
        if (miss.length) throw new Error(`${label} nicht gefunden: ${miss.join(', ')}`);
        for (const f of found) { ids.add(f.id); names[f.id] = display(k, f); }
      }
      for (const raw of c.names ?? []) {
        const [grp, val] = k === 'property' && raw.includes(':') ? raw.split(/:(.*)/s).map(s => s.trim()) : [null, raw.trim()];
        const filter = [{ type: 'equals', field: 'name', value: val }, ...(grp ? [{ type: 'equals', field: 'group.name', value: grp }] : [])];
        const found = (await ro.search(entity, { filter, limit: 25, ...crit })).data;
        if (!found.length) {
          const sug = (await ro.search(entity, { term: val, limit: 5, ...crit })).data;
          throw new Error(`${label} „${raw}“ nicht gefunden${sug.length ? ` – ähnlich: ${sug.map(s => `${display(k, s)} (${s.id})`).join('; ')}` : ''}`);
        }
        if (k === 'category' && found.length > 1) throw new Error(`Kategorie „${raw}“ ist mehrdeutig: ${found.map(f => `${catPath(f)} (${f.id})`).join('; ')} – bitte ids angeben`);
        if (found.length > 1) notes.push(`${label} „${raw}“ passt auf ${found.length} Einträge – alle einbezogen`);
        for (const f of found) { ids.add(f.id); names[f.id] = display(k, f); }
      }
      conds.push({ ...c, ids: [...ids], names: undefined });
    }
    out.push({ conditions: conds });
  }
  return { groups: out, names, notes };
}

/** Sales channel for the preview: the named one or the first with a domain (storefront) */
async function channel(ro: ShopReader, id?: string) {
  const sc = await ro.salesChannels();
  const c = id ? sc.find(s => s.id === id) : sc.find(s => s.domains?.length) ?? sc[0];
  if (!c) throw new Error(id ? `Verkaufskanal ${id} nicht gefunden` : 'Kein Verkaufskanal gefunden');
  return { id: c.id as string, name: nameOf(c) };
}

export interface PreviewProduct { id: string; number: string; name: string; price: number | null; image: string | null }
/** Matches according to Shopware (stream preview per sales channel): total + examples */
export async function previewStream(ro: ShopReader, salesChannelId: string, roots: FilterNode[], limit = 6): Promise<{ total: number; sample: PreviewProduct[] }> {
  const r = await ro.req('POST', `/_admin/product-stream-preview/${salesChannelId}`, { filter: roots, limit: Math.max(1, limit), page: 1, 'total-count-mode': 1, associations: { cover: { associations: { media: {} } } } });
  const els: SwEntity[] = Array.isArray(r?.elements) ? r.elements : Object.values(r?.elements ?? {});
  return { total: Number(r?.total ?? els.length), sample: (limit > 0 ? els.slice(0, limit) : []).map(p => ({
    id: p.id, number: p.productNumber, name: nameOf(p) || p.productNumber, price: p.calculatedPrice?.unitPrice ?? p.calculatedCheapestPrice?.unitPrice ?? null, image: p.cover?.media?.url ?? null,
  })) };
}

const STREAM_CRIT = { associations: { filters: {}, categories: {}, productCrossSellings: { associations: { product: {} } } } };
const usage = (s: SwEntity) => ({
  categories: ((s.categories ?? []) as SwEntity[]).map(c => ({ id: c.id, name: catPath(c), active: c.active, dynamic: c.productAssignmentType === 'product_stream' })),
  crossSellings: ((s.productCrossSellings ?? []) as SwEntity[]).map(x => ({ id: x.id, name: nameOf(x), product: x.product ? prodLabel(x.product) : x.productId, active: x.active })),
});
const rowOf = (f: SwEntity): FilterRow => ({ id: f.id, type: f.type, field: f.field ?? null, operator: f.operator ?? null, value: f.value ?? null, parameters: f.parameters ?? null, position: f.position ?? 0, parentId: f.parentId ?? null });
/** State of a stream for the stale-write guard: name, description, rule tree (without filter IDs) */
const streamState = (s: SwEntity) => ({ name: nameOf(s), description: s.translated?.description ?? s.description ?? null, tree: rowsToTree(((s.filters ?? []) as SwEntity[]).map(rowOf)) });
/** Product assignment of a category for the stale-write guard */
const assignState = (c: SwEntity) => ({ productAssignmentType: c.productAssignmentType ?? 'product', productStreamId: c.productStreamId ?? null });

// ================= Change set: create/change streams =================
export interface StreamInput { id?: string; name: string; description?: string; groups: GroupSpec[] }
export interface StreamArgs { title: string; reason: string; salesChannelId?: string; streams: StreamInput[] }
export interface StreamPayload { mode: 'create' | 'update'; id: string; name: string; description: string | null; rows: FilterRow[] }

export async function buildStreamChangeSet(ro: ShopReader, { title, reason, salesChannelId, streams }: StreamArgs): Promise<ChangeSet> {
  if (!streams?.length) throw new Error('streams ist leer');
  if (streams.length > MAX_STREAMS) throw new Error(`Höchstens ${MAX_STREAMS} Produktstreams pro Änderungsset – bitte aufteilen.`);
  const sc = await channel(ro, salesChannelId);
  const wanted = [...new Set(streams.map(s => s.name?.trim()).filter(Boolean))];
  const taken = new Map((await ro.search('product-stream', { filter: [{ type: 'equalsAny', field: 'name', value: wanted }], limit: 100 })).data.map(s => [nameOf(s).toLowerCase(), s.id as string]));
  const items: ChangeItem[] = [], assets: ChangeAsset[] = [], skipped: { id: string; reason: string }[] = [], seen = new Set<string>();
  let unchanged = 0;
  for (const [i, s] of streams.entries()) {
    const key = `stream-${i + 1}`;
    try {
      const name = String(s.name ?? '').trim();
      if (!name || name.length > 255) throw new Error('Name fehlt oder ist länger als 255 Zeichen');
      if (s.id && seen.has(s.id)) throw new Error('Stream doppelt im Set');
      const { groups, names, notes } = await resolveGroups(ro, s.groups);
      const tree = specToTree(groups);
      const old = s.id ? await ro.get('product-stream', s.id, STREAM_CRIT) : null;
      if (s.id && !old) throw new Error(`Produktstream ${s.id} nicht gefunden`);
      const oldRoots = old ? rowsToTree(((old.filters ?? []) as SwEntity[]).map(rowOf)) : [];
      const all = { ...names, ...(old ? await lookupNames(ro, [oldRoots]) : {}) };
      const oldDesc = old ? (old.translated?.description ?? old.description ?? null) : null;
      const desc = s.description != null ? s.description.trim() || null : oldDesc;
      if (old && sameTree(oldRoots, [tree]) && name === nameOf(old) && desc === oldDesc) { unchanged++; continue; }
      const rule = renderRule([tree], all), pv = await previewStream(ro, sc.id, [tree], 6);
      const warn = [...notes];
      if (!pv.total) warn.push(`Keine Treffer in „${sc.name}“`);
      const dupe = taken.get(name.toLowerCase()); if (dupe && dupe !== s.id) warn.push('Name existiert bereits');
      if (old) {
        const u = usage(old), nCat = u.categories.filter(c => c.dynamic).length, nX = u.crossSellings.length;
        if (nCat || nX) warn.push(`Wirkt sofort auf ${nCat} Kategorie(n) und ${nX} Cross-Selling(s)`);
        if (oldRoots.length && !treeToSpec(oldRoots)) warn.push('Bisherige Regel enthält Sonderbedingungen, sie werden ersetzt');
      }
      const id = s.id ?? newId(); seen.add(id);
      const payload: StreamPayload = { mode: old ? 'update' : 'create', id, name, description: desc, rows: treeToRows([tree], newId) };
      const sample = pv.sample.map(p => `• ${p.name} (${p.number})${p.price != null ? ` · ${eur(p.price)}` : ''}`).join('\n');
      items.push({
        id: key, entity: 'product-stream', entityId: id, label: old && nameOf(old) !== name ? `${nameOf(old)} → ${name}` : name, field: old ? 'filters' : 'create', fieldLabel: old ? 'Regel' : 'Neuer Produktstream',
        before: old ? renderRule(oldRoots, all) : '–', after: `${rule} · ${hits(pv.total)} in „${sc.name}“`, afterRaw: payload, beforeRaw: old ? streamState(old) : undefined, warn,
        html: { before: old ? `Name: ${nameOf(old)}\nBeschreibung: ${oldDesc ?? '–'}\nRegel: ${renderRule(oldRoots, all)}` : '', after: `Name: ${name}\nBeschreibung: ${desc ?? '–'}\nRegel: ${rule}\nTreffer: ${pv.total} (Verkaufskanal „${sc.name}“)\n\nBeispiele:\n${sample || '–'}` },
      });
      for (const p of pv.sample) if (p.image && assets.length < 24 && !assets.some(a => a.url === p.image)) assets.push({ name: p.name, url: p.image, alt: p.name, note: `Treffer · ${name}` });
    } catch (e) { skipped.push({ id: key, reason: `${s?.name ?? key}: ${errMsg(e)}` }); }
  }
  if (!items.length) throw new Error(`Nichts anzulegen oder zu ändern (${unchanged} unverändert${skipped.length ? `; übersprungen: ${skipped.map(x => x.reason).join('; ')}` : ''})`);
  const single = items.length === 1 ? (items[0].field === 'create' ? 'Produktstream anlegen' : 'Produktstream ändern') : 'Produktstreams speichern';
  return { id: newId(), kind: 'product-streams', entity: 'product-stream', noun: { one: 'Produktstream', many: 'Produktstreams' }, applyLabel: single, title, reason, items, assets, skipped, unchanged, atomic: false };
}

/** Writes a stream; undo: newly created → delete (filters cascade), changed → delete new filters and recreate the old tree with the same IDs.
 *  before = the item's beforeRaw (stale-write guard: stream changed in the meantime → do not overwrite) */
export async function applyStream(swW: Shopware, p: StreamPayload, before?: unknown): Promise<UndoOp[]> {
  if (p.mode === 'create') {
    await swW.create('product-stream', { id: p.id, name: p.name, ...(p.description ? { description: p.description } : {}), filters: p.rows });
    return [{ op: 'delete', entity: 'product-stream', id: p.id }];
  }
  const cur = await swW.get('product-stream', p.id, { associations: { filters: {} } });
  if (!cur) throw new Error('Produktstream nicht mehr vorhanden');
  assertFresh('Produktstream', streamState(cur), before);
  const restore = { name: cur.name ?? nameOf(cur), description: cur.description ?? null, filters: ((cur.filters ?? []) as SwEntity[]).map(rowOf) };
  for (const r of restore.filters.filter(r => !r.parentId)) await swW.req('DELETE', `/product-stream-filter/${r.id}`); // children are deleted along with it
  try { await swW.update('product-stream', p.id, { name: p.name, description: p.description, filters: p.rows }); }
  catch (e) { await swW.update('product-stream', p.id, restore).catch(() => {}); throw e; }
  return [
    { op: 'patch', entity: 'product-stream', id: p.id, data: restore },
    ...p.rows.filter(r => !r.parentId).map((r): UndoOp => ({ op: 'req', method: 'DELETE', path: `/product-stream-filter/${r.id}`, entity: 'product-stream-filter', id: r.id })),
  ];
}
registerApplier('product-streams', (swW, cs, _payload, selected, ctx) => applyEach(cs, selected, it => applyStream(swW, it.afterRaw as StreamPayload, it.beforeRaw), ctx));

// ================= Change set: assign stream (category / cross-selling) =================
export const CS_SORT = ['name', 'cheapestPrice', 'releaseDate'] as const;
const SORT_LABEL: Record<string, string> = { name: 'Name', cheapestPrice: 'Preis', releaseDate: 'Erscheinungsdatum' };
export interface CrossSellingOpts { name: string; position?: number; limit?: number; sortBy?: typeof CS_SORT[number]; sortDirection?: 'ASC' | 'DESC'; active?: boolean }
export interface AssignArgs { title: string; reason: string; streamId: string | null; categoryIds?: string[]; productIds?: string[]; crossSelling?: CrossSellingOpts; salesChannelId?: string }
export type AssignPayload =
  | { kind: 'category'; categoryId: string; productAssignmentType: 'product' | 'product_stream'; productStreamId: string | null }
  | { kind: 'cross-selling'; id: string; productId: string; name: string; productStreamId: string; position: number; limit: number; sortBy: string; sortDirection: 'ASC' | 'DESC'; active: boolean };

export async function buildStreamAssignmentChangeSet(ro: ShopReader, a: AssignArgs): Promise<ChangeSet> {
  const catIds = [...new Set(a.categoryIds ?? [])], prodIds = [...new Set(a.productIds ?? [])];
  if (!catIds.length && !prodIds.length) throw new Error('categoryIds und/oder productIds angeben');
  if (catIds.length + prodIds.length > MAX_ITEMS) throw new Error(`Höchstens ${MAX_ITEMS} Ziele pro Änderungsset – bitte aufteilen.`);
  if (prodIds.length && !a.streamId) throw new Error('Cross-Selling braucht einen streamId');
  const xs = a.crossSelling;
  if (prodIds.length && !xs?.name?.trim()) throw new Error('crossSelling.name angeben (Titel im Shop, z. B. „Passend dazu“)');
  if (xs?.limit != null && !(Number.isInteger(xs.limit) && xs.limit >= 1 && xs.limit <= 100)) throw new Error('crossSelling.limit: 1–100');
  const stream = a.streamId ? await ro.get('product-stream', a.streamId, { associations: { filters: {} } }) : null;
  if (a.streamId && !stream) throw new Error(`Produktstream ${a.streamId} nicht gefunden`);
  const items: ChangeItem[] = [], assets: ChangeAsset[] = [], skipped: { id: string; reason: string }[] = [];
  let unchanged = 0, total = 0;
  if (stream) {
    const roots = rowsToTree(((stream.filters ?? []) as SwEntity[]).map(rowOf)), sc = await channel(ro, a.salesChannelId), pv = await previewStream(ro, sc.id, roots, 6);
    total = pv.total;
    items.push({ id: 'info', entity: 'info', label: `Produktstream „${nameOf(stream)}“`, fieldLabel: 'Regel', before: '', after: `${renderRule(roots, await lookupNames(ro, [roots]))} · ${hits(pv.total)} in „${sc.name}“`, warn: pv.total ? [] : ['Stream hat keine Treffer'] });
    for (const p of pv.sample) if (p.image && !assets.some(x => x.url === p.image)) assets.push({ name: p.name, url: p.image, alt: p.name, note: 'Treffer im Stream' });
  }
  const sName = stream ? `„${nameOf(stream)}“` : '';

  if (catIds.length) {
    const cats = (await ro.search('category', { ids: catIds, limit: catIds.length, associations: { productStream: {} } })).data;
    for (const id of catIds) {
      const c = cats.find(x => x.id === id);
      if (!c) { skipped.push({ id, reason: 'Kategorie nicht gefunden' }); continue; }
      if (c.type && c.type !== 'page') { skipped.push({ id, reason: `${catPath(c)}: Kategorie vom Typ „${c.type}“ zeigt keine Produkte` }); continue; }
      const dyn = c.productAssignmentType === 'product_stream';
      if (a.streamId ? dyn && c.productStreamId === a.streamId : !dyn) { unchanged++; continue; }
      const manual = (await ro.search('product', { limit: 1, 'total-count-mode': 1, filter: [{ type: 'equals', field: 'categories.id', value: id }] })).total ?? 0;
      const warn: string[] = [];
      if (a.streamId && !dyn && manual) warn.push(`${manual} manuell zugeordnete Produkte werden nicht mehr angezeigt (bleiben gespeichert)`);
      if (!a.streamId && !manual) warn.push('Keine manuell zugeordneten Produkte, Kategorie zeigt dann nichts');
      if (c.active === false) warn.push('Kategorie ist inaktiv');
      const payload: AssignPayload = { kind: 'category', categoryId: id, productAssignmentType: a.streamId ? 'product_stream' : 'product', productStreamId: a.streamId };
      items.push({ id: `cat:${id}`, entity: 'category', entityId: id, label: catPath(c), field: 'productAssignment', fieldLabel: 'Produktzuordnung',
        before: dyn ? `dynamisch: Produktstream „${nameOf(c.productStream) || c.productStreamId}“` : `manuell (${manual} Produkte)`,
        after: a.streamId ? `dynamisch: Produktstream ${sName} (${hits(total)})` : `manuell (${manual} Produkte)`, afterRaw: payload, beforeRaw: assignState(c), warn });
    }
  }

  if (prodIds.length && stream && xs) {
    const prods = (await ro.search('product', { ids: prodIds, limit: prodIds.length })).data;
    const existing = (await ro.search('product-cross-selling', { filter: [{ type: 'equalsAny', field: 'productId', value: prodIds }], limit: 500 })).data;
    const limit = xs.limit ?? 24, sortBy = xs.sortBy ?? 'name', dir = xs.sortDirection ?? 'ASC', active = xs.active !== false;
    for (const id of prodIds) {
      const p = prods.find(x => x.id === id);
      if (!p) { skipped.push({ id, reason: 'Produkt nicht gefunden' }); continue; }
      const mine = existing.filter(x => x.productId === id).sort((x, y) => x.position - y.position);
      if (mine.some(x => x.type === 'productStream' && x.productStreamId === a.streamId)) { unchanged++; continue; }
      const position = xs.position ?? (mine.length ? Math.max(...mine.map(x => x.position ?? 0)) + 1 : 1);
      const warn: string[] = [];
      if (!active) warn.push('Wird inaktiv angelegt');
      if (p.parentId) warn.push('Variante: gilt nur für diese Variante');
      if (!total) warn.push('Stream hat keine Treffer');
      const payload: AssignPayload = { kind: 'cross-selling', id: newId(), productId: id, name: xs.name.trim(), productStreamId: a.streamId!, position, limit, sortBy, sortDirection: dir, active };
      items.push({ id: `xs:${id}`, entity: 'product', entityId: id, label: prodLabel(p), field: 'crossSelling', fieldLabel: 'Cross-Selling',
        before: mine.length ? mine.map(x => `„${nameOf(x)}“`).join(', ') : '–',
        after: `+ „${payload.name}“: Produktstream ${sName}, max. ${limit}, nach ${SORT_LABEL[sortBy] ?? sortBy} ${dir === 'ASC' ? 'aufsteigend' : 'absteigend'}`, afterRaw: payload, warn });
    }
  }
  if (!items.some(i => i.entity !== 'info')) throw new Error(`Nichts zuzuordnen (${unchanged} unverändert${skipped.length ? `; übersprungen: ${skipped.map(x => x.reason).join('; ')}` : ''})`);
  return { id: newId(), kind: 'product-stream-assignment', noun: { one: 'Ziel', many: 'Ziele' }, applyLabel: 'Zuordnung speichern', title: a.title, reason: a.reason, items, assets, skipped, unchanged, atomic: false };
}

/** Write the assignment; undo: restore the category's old assignment or delete the new cross-selling. before = the item's beforeRaw (stale-write guard) */
export async function applyAssignment(swW: Shopware, p: AssignPayload, before?: unknown): Promise<UndoOp> {
  if (p.kind === 'category') {
    const cur = await swW.get('category', p.categoryId);
    if (!cur) throw new Error('Kategorie nicht mehr vorhanden');
    assertFresh('Produktzuordnung', assignState(cur), before);
    await swW.update('category', p.categoryId, { productAssignmentType: p.productAssignmentType, productStreamId: p.productStreamId });
    return { op: 'patch', entity: 'category', id: p.categoryId, data: { productAssignmentType: cur.productAssignmentType ?? 'product', productStreamId: cur.productStreamId ?? null } };
  }
  await swW.create('product-cross-selling', { id: p.id, productId: p.productId, name: p.name, type: 'productStream', productStreamId: p.productStreamId, position: p.position, limit: p.limit, sortBy: p.sortBy, sortDirection: p.sortDirection, active: p.active });
  return { op: 'delete', entity: 'product-cross-selling', id: p.id };
}
registerApplier('product-stream-assignment', (swW, cs, _payload, selected, ctx) => applyEach(cs, selected, it => applyAssignment(swW, it.afterRaw as AssignPayload, it.beforeRaw), ctx));

// ================= Tools =================
const condSchema = z.object({
  field: z.enum(COND_FIELDS).describe('category | manufacturer | property (Eigenschaftswert) | tag | productNumber | price (Bruttopreis €) | onSale (Streichpreis vorhanden) | stock | active | releaseDate'),
  ids: z.array(z.string()).optional().describe('IDs für category/manufacturer/property/tag (bevorzugt)'),
  names: z.array(z.string()).optional().describe('Alternativ exakte Namen; Eigenschaft als "Gruppe: Wert" (z. B. "Farbe: Blau"). Mehrere Werte = ODER'),
  values: z.array(z.string()).optional().describe('productNumber: Produktnummern'),
  min: z.number().optional().describe('price/stock: Untergrenze (≥); onSale: Mindest-Rabatt in %'),
  max: z.number().optional().describe('price/stock: Obergrenze (≤)'),
  value: z.boolean().optional().describe('active: true/false; onSale: false = NICHT im Angebot'),
  from: z.string().optional().describe('releaseDate ab JJJJ-MM-TT'), to: z.string().optional().describe('releaseDate bis JJJJ-MM-TT'),
  includeSubcategories: z.boolean().optional().describe('category: Unterkategorien einschließen (Standard true)'),
  negate: z.boolean().optional().describe('true = Bedingung verneinen (NICHT)'),
});
const groupsSchema = z.array(z.object({ conditions: z.array(condSchema).min(1) })).min(1)
  .describe('Regel: Gruppen sind ODER-verknüpft, Bedingungen innerhalb einer Gruppe UND-verknüpft. Beispiel „Wohnaccessoires bis 50 €“: [{conditions:[{field:"category",names:["Wohnaccessoires"]},{field:"price",max:50}]}]');

const TOOL_NAMES = ['list_product_streams', 'get_product_stream', 'preview_product_stream', 'propose_product_stream', 'propose_stream_assignment'];

export const streams: Feature = {
  key: 'streams',
  platforms: ['shopware'],
  toolNames: TOOL_NAMES,
  tools: (session: Session) => {
    const sw = session.sw;
    return [
      tool('list_product_streams', 'Listet Produktstreams (dynamische Produktgruppen) mit lesbarer Regel, Verwendung (Kategorien mit dynamischer Zuordnung, Cross-Sellings) und – optional – Trefferzahl im Verkaufskanal. Suche per term, Paginierung via offset (max. 50 je Aufruf). Ändert nichts.',
        { term: z.string().optional(), limit: z.number().optional(), offset: z.number().optional().describe('Vielfaches von limit; das Ergebnis nennt den wirksamen offset'), withCounts: z.boolean().optional().describe('Trefferzahl je Stream ermitteln (Standard true)'), salesChannelId: z.string().optional() },
        guard(async a => {
          const limit = Math.min(Math.max(Math.floor(a.limit ?? 25), 1), 50), offset = Math.floor(Math.max(a.offset ?? 0, 0) / limit) * limit;
          const r = await sw.search('product-stream', { limit, page: Math.floor(offset / limit) + 1, 'total-count-mode': 1, ...(a.term ? { term: a.term } : { sort: [{ field: 'name', order: 'ASC' }] }), ...STREAM_CRIT });
          const trees = r.data.map(s => rowsToTree(((s.filters ?? []) as SwEntity[]).map(rowOf)));
          const names = await lookupNames(sw, trees), sc = a.withCounts === false ? null : await channel(sw, a.salesChannelId);
          const counts = sc ? await pool(trees, 4, t => previewStream(sw, sc.id, t, 0).then(x => x.total).catch(() => null)) : [];
          return ok({ total: r.total, offset, returned: r.data.length, ...(sc ? { salesChannel: sc.name } : {}), streams: r.data.map((s, i) => {
            const u = usage(s);
            return { id: s.id, name: nameOf(s), description: s.translated?.description ?? s.description ?? null, rule: renderRule(trees[i], names), ...(s.invalid ? { invalid: true } : {}), ...(sc ? { matching: counts[i] } : {}),
              usedIn: { categories: u.categories.map(c => `${c.name}${c.dynamic ? '' : ' (Stream hinterlegt, Zuordnung manuell)'}`), crossSellings: u.crossSellings.length } };
          }) });
        })),

      tool('get_product_stream', 'Details eines Produktstreams: Name, Beschreibung, lesbare Regel, Regel als Bedingungen (spec, zum Ändern per propose_product_stream; null = Sonderbedingungen aus der Administration), Verwendung (Kategorien, Cross-Sellings bei Produkten) sowie Trefferzahl und Beispielprodukte laut Shopware-Vorschau. Ändert nichts.',
        { id: z.string(), sampleLimit: z.number().optional().describe('Beispielprodukte (Standard 8, max. 24)'), salesChannelId: z.string().optional() },
        guard(async ({ id, sampleLimit, salesChannelId }) => {
          const s = await sw.get('product-stream', id, STREAM_CRIT);
          if (!s) return fail('Produktstream nicht gefunden');
          const roots = rowsToTree(((s.filters ?? []) as SwEntity[]).map(rowOf)), sc = await channel(sw, salesChannelId);
          const pv = await previewStream(sw, sc.id, roots, Math.min(Math.max(sampleLimit ?? 8, 0), 24));
          return ok({ id: s.id, name: nameOf(s), description: s.translated?.description ?? s.description ?? null, rule: renderRule(roots, await lookupNames(sw, [roots])), spec: treeToSpec(roots), ...(s.invalid ? { invalid: true } : {}),
            matching: { salesChannel: sc.name, total: pv.total, sample: pv.sample }, usedIn: usage(s) });
        })),

      tool('preview_product_stream', 'PRÜFT eine Regel, bevor ein Stream vorgeschlagen wird: löst Namen zu IDs auf, zeigt die lesbare Regel, die Trefferzahl im Verkaufskanal und Beispielprodukte. Schreibt nichts und legt keinen Stream an.',
        { groups: groupsSchema, salesChannelId: z.string().optional(), sampleLimit: z.number().optional() },
        guard(async ({ groups, salesChannelId, sampleLimit }) => {
          const res = await resolveGroups(sw, groups as GroupSpec[]), tree = specToTree(res.groups), sc = await channel(sw, salesChannelId);
          const pv = await previewStream(sw, sc.id, [tree], Math.min(Math.max(sampleLimit ?? 8, 0), 24));
          return ok({ rule: renderRule([tree], res.names), salesChannel: sc.name, total: pv.total, sample: pv.sample, resolved: res.groups, ...(res.notes.length ? { notes: res.notes } : {}) });
        })),

      tool('propose_product_stream', `SCHLÄGT neue Produktstreams vor oder ändert bestehende (mit id: Name/Beschreibung/Regel, die Regel wird komplett ersetzt). Max. ${MAX_STREAMS} Streams je Set. Es wird NICHTS geschrieben: Der Nutzer sieht Regel, Trefferzahl und Beispielprodukte und gibt frei; erst dann schreibt der Server. Ordnet den Stream KEINER Kategorie zu (dafür propose_stream_assignment). Rückgängig löscht neue Streams bzw. stellt die alte Regel wieder her.`,
        { title: z.string().describe('Kurzer Titel, z. B. "Stream „Wohnaccessoires bis 50 €“ anlegen"'), reason: z.string().describe('Regel/Zweck in 1–2 Sätzen'), salesChannelId: z.string().optional().describe('Verkaufskanal für die Trefferzählung (Standard: erster mit Domain)'),
          streams: z.array(z.object({ id: z.string().optional().describe('Nur zum Ändern: productStreamId'), name: z.string().describe('Klarer Name, der die Regel beschreibt'), description: z.string().optional(), groups: groupsSchema })).min(1) },
        guard(async a => {
          const cs = await buildStreamChangeSet(sw, a as StreamArgs);
          const res = await session.requestChange(cs);
          const failed = new Set((res.failed ?? []).map(f => f.item));
          return ok({ ...res, streams: res.status === 'rejected' ? undefined : cs.items.filter(i => !failed.has(i.id)).map(i => ({ id: i.entityId, name: (i.afterRaw as StreamPayload).name })) });
        })),

      tool('propose_stream_assignment', 'SCHLÄGT vor, einen Produktstream zu verwenden: (a) categoryIds → Kategorie zeigt die Stream-Produkte dynamisch (Produktzuordnung „Dynamische Produktgruppe“; manuell zugeordnete Produkte bleiben gespeichert, werden aber nicht angezeigt); streamId null → zurück auf manuelle Zuordnung. (b) productIds + crossSelling → legt bei diesen Produkten ein Cross-Selling vom Typ Produktstream an. Es wird NICHTS geschrieben, bis der Nutzer freigibt. Ändert keine Stream-Regel; Rückgängig stellt die vorherige Zuordnung wieder her bzw. löscht die neuen Cross-Sellings.',
        { title: z.string(), reason: z.string(), streamId: z.string().nullable().describe('productStreamId; null nur für Kategorien = zurück auf manuell'),
          categoryIds: z.array(z.string()).optional(), productIds: z.array(z.string()).optional(),
          crossSelling: z.object({ name: z.string().describe('Titel im Shop, z. B. "Passend dazu"'), position: z.number().optional(), limit: z.number().optional().describe('max. Produkte (Standard 24)'), sortBy: z.enum(CS_SORT).optional(), sortDirection: z.enum(['ASC', 'DESC']).optional(), active: z.boolean().optional() }).optional(),
          salesChannelId: z.string().optional() },
        guard(async a => { const cs = await buildStreamAssignmentChangeSet(sw, a as AssignArgs); return ok(await session.requestChange(cs)); })),
    ] as AnyTool[];
  },
};

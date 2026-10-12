import 'server-only';
// Shopify: Änderungssets für Kollektionen (Texte/SEO/Sichtbarkeit, neue Kollektionen und Regeln = automatische Kollektionen, Produktzuordnung),
// Produktbilder, Alt-Texte und Handles (SEO-URLs mit Weiterleitung) – jeweils mit exakten Rückgängig-Schritten.
import type { ChangeAsset, ChangeItem, ChangeSet, UndoOp } from '@/lib/protocol';
import { slugify as slug } from '@/lib/text';
import { MAX_ITEMS, WRITE_CONCURRENCY, assertFresh, cut, errMsg, partialTicker, pool, type ApplyCtx, type ApplyResult } from '../../changes';
import { checkAlt } from '../../features/bilder';
import { stagedMeta } from '../../media';
import { newId } from '../../shopware';
import { shortId, toGid, type Json, type ShopifyClient } from './client';
import { collectionsByIds, idsWhere, mediaByIds, pagesByIds, productsByIds, qField, stripHtml, type Q } from './data';
import { deleteOp, isUserError, M, reqOp, run, runCreating, runRecording } from './ops';
import { onlineStorePublication } from './products';
import { uploadStagedImage } from './upload';

const SORT_ORDERS = ['MANUAL', 'BEST_SELLING', 'ALPHA_ASC', 'ALPHA_DESC', 'PRICE_ASC', 'PRICE_DESC', 'CREATED', 'CREATED_DESC'] as const;
const SORT_DE: Record<string, string> = { MANUAL: 'manuell', BEST_SELLING: 'Bestseller', ALPHA_ASC: 'A bis Z', ALPHA_DESC: 'Z bis A', PRICE_ASC: 'Preis aufsteigend', PRICE_DESC: 'Preis absteigend', CREATED: 'älteste zuerst', CREATED_DESC: 'neueste zuerst' };

// =============== Kollektionen: Texte, SEO, Sichtbarkeit, Sortierung ===============
export const COLLECTION_FIELDS: Record<string, { label: string; kind: 'str' | 'html' | 'bool' | 'sort' }> = {
  name: { label: 'Name', kind: 'str' }, description: { label: 'Beschreibung', kind: 'html' }, metaTitle: { label: 'Meta-Title (SEO)', kind: 'str' },
  metaDescription: { label: 'Meta-Description (SEO)', kind: 'str' }, active: { label: 'Im Online Store sichtbar', kind: 'bool' }, sortOrder: { label: 'Sortierung', kind: 'sort' },
};
export async function buildCollectionChangeSet(q: Q, a: { title: string; reason: string; changes: { id: string; fields: Record<string, unknown> }[] }): Promise<ChangeSet> {
  if (!a.changes?.length) throw new Error('changes ist leer');
  if (a.changes.length > MAX_ITEMS) throw new Error(`Maximal ${MAX_ITEMS} Kollektionen pro Änderungsset.`);
  const rows = await collectionsByIds(q, a.changes.map(c => c.id).filter(i => /^\d+$|^gid:\/\/shopify\/Collection\//.test(i)));
  const by = new Map(rows.map(c => [shortId(c.id), c]));
  const items: ChangeItem[] = [], skipped: { id: string; reason: string }[] = []; let unchanged = 0;
  for (const ch of a.changes) {
    const c = by.get(shortId(String(ch.id)));
    if (!c) { skipped.push({ id: String(ch.id), reason: 'Kollektion nicht gefunden' }); continue; }
    const id = shortId(c.id);
    for (const [field, raw] of Object.entries(ch.fields ?? {})) {
      const def = COLLECTION_FIELDS[field];
      if (!def) { skipped.push({ id, reason: `Feld "${field}" nicht erlaubt (erlaubt: ${Object.keys(COLLECTION_FIELDS).join(', ')})` }); continue; }
      try {
        let cur: unknown, before: string, after: string; const warn: string[] = [];
        if (def.kind === 'bool') {
          if (typeof raw !== 'boolean') throw new Error('true/false erwartet');
          cur = !!c.onlineStoreUrl; before = cur ? 'sichtbar' : 'nicht veröffentlicht'; after = raw ? 'sichtbar' : 'nicht veröffentlicht';
          if (!raw) warn.push('Kollektion verschwindet aus dem Online Store (Links darauf führen ins Leere)');
        } else if (def.kind === 'sort') {
          if (!SORT_ORDERS.includes(raw as typeof SORT_ORDERS[number])) throw new Error(`Sortierung: ${SORT_ORDERS.join(', ')}`);
          cur = c.sortOrder; before = SORT_DE[c.sortOrder] ?? c.sortOrder; after = SORT_DE[raw as string];
        } else {
          if (typeof raw !== 'string') throw new Error('Text erwartet');
          if (def.kind === 'str' && raw.length > 255) throw new Error('max. 255 Zeichen');
          if (field === 'name' && !raw.trim()) throw new Error('Name darf nicht leer sein');
          cur = field === 'name' ? c.title : field === 'description' ? c.descriptionHtml : field === 'metaTitle' ? c.seo?.title : c.seo?.description;
          before = cut(cur); after = cut(raw);
        }
        if (cur === raw || (cur == null && raw === '')) { unchanged++; continue; }
        items.push({ id: `${id}:${field}`, entity: 'category', entityId: id, label: c.title, field, fieldLabel: def.label, before, after, afterRaw: raw, beforeRaw: cur ?? null, html: def.kind === 'html' ? { before: String(cur ?? '').slice(0, 4000), after: String(raw).slice(0, 4000) } : undefined, warn });
      } catch (e) { skipped.push({ id, reason: `${field}: ${errMsg(e)}` }); }
    }
  }
  if (!items.length) throw new Error(`Keine Änderung nötig bzw. nichts anwendbar (${unchanged} unverändert, ${skipped.length} übersprungen: ${skipped.slice(0, 3).map(s => s.reason).join('; ')})`);
  return { id: newId(), kind: 'categories', entity: 'category', title: a.title, reason: a.reason, items, skipped, unchanged, atomic: false, noun: { one: 'Kollektion', many: 'Kollektionen' } };
}

const PUBLISHED = 'query Published($id: ID!, $pub: ID!) { collection(id: $id) { publishedOnPublication(publicationId: $pub) } }';
export async function applyCollections(client: ShopifyClient, cs: ChangeSet, selected: Set<string>, ctx?: ApplyCtx): Promise<ApplyResult> {
  const groups = new Map<string, ChangeItem[]>();
  let n = 0;
  for (const it of cs.items) if (selected.has(it.id) && it.entityId) { groups.set(it.entityId, [...(groups.get(it.entityId) ?? []), it]); n++; }
  const results: ApplyResult['results'] = [], undo: UndoOp[] = [], tick = partialTicker(ctx, n, { results, undo });
  let pub: string | null = null;
  await pool([...groups.values()], WRITE_CONCURRENCY, async its => {
    const ok = (list: ChangeItem[]) => list.forEach(i => results.push({ itemId: i.id, ok: true }));
    const bad = (list: ChangeItem[], e: unknown) => list.forEach(i => results.push({ itemId: i.id, ok: false, error: errMsg(e) }));
    try {
      const [c] = await collectionsByIds((d, v) => client.gql(d, v), [its[0].entityId!]);
      if (!c) throw new Error('Kollektion nicht mehr vorhanden');
      const freshOf = (it: ChangeItem) => it.field === 'name' ? c.title : it.field === 'description' ? (c.descriptionHtml ?? null) : it.field === 'sortOrder' ? c.sortOrder : it.field === 'metaTitle' ? (c.seo?.title ?? null) : it.field === 'metaDescription' ? (c.seo?.description ?? null) : it.field === 'active' ? !!c.onlineStoreUrl : undefined;
      const live = its.filter(it => {
        if (it.beforeRaw === undefined) return true;
        try { assertFresh(it.fieldLabel, freshOf(it), it.beforeRaw); return true; }
        catch (e) { results.push({ itemId: it.id, ok: false, error: errMsg(e) }); return false; }
      });
      const input: Json = { id: c.id }, back: Json = { id: c.id }, upd: ChangeItem[] = [];
      for (const it of live) {
        if (it.field === 'active') continue;
        if (it.field === 'name') { input.title = it.afterRaw; back.title = c.title; }
        else if (it.field === 'description') { input.descriptionHtml = it.afterRaw; back.descriptionHtml = c.descriptionHtml ?? ''; }
        else if (it.field === 'sortOrder') { input.sortOrder = it.afterRaw; back.sortOrder = c.sortOrder; }
        else { const seo = { title: c.seo?.title ?? null, description: c.seo?.description ?? null }; input.seo = { ...seo, ...(input.seo ?? {}), [it.field === 'metaTitle' ? 'title' : 'description']: it.afterRaw }; back.seo = seo; }
        upd.push(it);
      }
      if (upd.length) { try { await runRecording(client, M.collectionUpdate, { input }, undo, reqOp('collection', c.id, M.collectionUpdate, { input: back })); ok(upd); } catch (e) { bad(upd, e); } }
      const vis = live.find(i => i.field === 'active');
      if (vis) {
        try {
          pub ??= await onlineStorePublication(client);
          const was = !!(await client.gql<Json>(PUBLISHED, { id: c.id, pub })).collection?.publishedOnPublication;
          if (was !== vis.afterRaw) await runRecording(client, vis.afterRaw ? M.publish : M.unpublish, { id: c.id, input: [{ publicationId: pub }] }, undo, reqOp('collection', c.id, vis.afterRaw ? M.unpublish : M.publish, { id: c.id, input: [{ publicationId: pub }] }));
          ok([vis]);
        } catch (e) { bad([vis], e); }
      }
    } catch (e) { bad(its, e); }
    finally { tick(); }
  });
  return { results, undo };
}

// =============== Neue Kollektionen / Regeln (automatische Kollektionen = Smart Collections mit Regel) ===============
export const RULE_COLUMNS = ['TAG', 'TITLE', 'TYPE', 'VENDOR', 'VARIANT_PRICE', 'VARIANT_COMPARE_AT_PRICE', 'VARIANT_INVENTORY', 'VARIANT_TITLE', 'IS_PRICE_REDUCED', 'VARIANT_WEIGHT'] as const;
export const RULE_RELATIONS = ['EQUALS', 'NOT_EQUALS', 'CONTAINS', 'NOT_CONTAINS', 'STARTS_WITH', 'ENDS_WITH', 'GREATER_THAN', 'LESS_THAN', 'IS_SET', 'IS_NOT_SET'] as const;
export interface Rule { column: string; relation: string; condition: string }
const COL_DE: Record<string, string> = { TAG: 'Tag', TITLE: 'Titel', TYPE: 'Produkttyp', VENDOR: 'Hersteller', VARIANT_PRICE: 'Preis', VARIANT_COMPARE_AT_PRICE: 'Vergleichspreis', VARIANT_INVENTORY: 'Bestand', VARIANT_TITLE: 'Variantentitel', IS_PRICE_REDUCED: 'reduziert', VARIANT_WEIGHT: 'Gewicht' };
const REL_DE: Record<string, string> = { EQUALS: '=', NOT_EQUALS: '≠', CONTAINS: 'enthält', NOT_CONTAINS: 'enthält nicht', STARTS_WITH: 'beginnt mit', ENDS_WITH: 'endet mit', GREATER_THAN: '>', LESS_THAN: '<', IS_SET: 'gesetzt', IS_NOT_SET: 'nicht gesetzt' };
export const ruleText = (rules: Rule[], disjunctive: boolean) => rules.map(r => `${COL_DE[r.column] ?? r.column} ${REL_DE[r.relation] ?? r.relation} ${r.condition}`).join(disjunctive ? ' ODER ' : ' UND ') || '–';
export function checkRules(rules: Rule[]): Rule[] {
  if (!Array.isArray(rules) || !rules.length || rules.length > 60) throw new Error('rules: 1 bis 60 Bedingungen erwartet');
  return rules.map((r, i) => {
    const column = String(r.column ?? '').toUpperCase(), relation = String(r.relation ?? '').toUpperCase(), condition = String(r.condition ?? '').trim();
    if (!RULE_COLUMNS.includes(column as typeof RULE_COLUMNS[number])) throw new Error(`Regel ${i + 1}: column ${column} unbekannt (${RULE_COLUMNS.join(', ')})`);
    if (!RULE_RELATIONS.includes(relation as typeof RULE_RELATIONS[number])) throw new Error(`Regel ${i + 1}: relation ${relation} unbekannt (${RULE_RELATIONS.join(', ')})`);
    if (!condition && !['IS_SET', 'IS_NOT_SET'].includes(relation)) throw new Error(`Regel ${i + 1}: condition fehlt`);
    if (/^VARIANT_(PRICE|COMPARE_AT_PRICE|INVENTORY|WEIGHT)$/.test(column) && !/^-?\d+([.,]\d+)?$/.test(condition)) throw new Error(`Regel ${i + 1}: Zahl erwartet`);
    return { column, relation, condition: condition.replace(',', '.') };
  });
}
/** Regel → Produktsuche (für die Trefferzählung); null = nicht abbildbar */
export function rulesQuery(rules: Rule[], disjunctive: boolean): string | null {
  const parts: string[] = [];
  for (const r of rules) {
    const neg = r.relation.startsWith('NOT_') ? '-' : '';
    const field = ({ TAG: 'tag', VENDOR: 'vendor', TYPE: 'product_type', TITLE: 'title' } as Record<string, string>)[r.column];
    if (field && ['EQUALS', 'NOT_EQUALS'].includes(r.relation)) parts.push(`${neg}${qField(field, r.condition)}`);
    else if (r.column === 'TITLE' && ['CONTAINS', 'NOT_CONTAINS'].includes(r.relation)) parts.push(`${neg}title:*${r.condition.replace(/[^\p{L}\p{N} -]/gu, '').split(' ')[0]}*`);
    else if (r.column === 'VARIANT_PRICE' && ['GREATER_THAN', 'LESS_THAN'].includes(r.relation)) parts.push(`price:${r.relation === 'GREATER_THAN' ? '>' : '<'}${Number(r.condition)}`);
    else if (r.column === 'VARIANT_INVENTORY' && ['GREATER_THAN', 'LESS_THAN'].includes(r.relation)) parts.push(`inventory_total:${r.relation === 'GREATER_THAN' ? '>' : '<'}${Number(r.condition)}`);
    else if (r.column === 'IS_PRICE_REDUCED') parts.push(`is_price_reduced:${r.condition === 'false' ? 'false' : 'true'}`);
    else return null;
  }
  return parts.join(disjunctive ? ' OR ' : ' AND ');
}

export interface CollectionInput { id?: string; name?: string; description?: string; metaTitle?: string; metaDescription?: string; handle?: string; rules?: Rule[]; disjunctive?: boolean; productIds?: string[]; sortOrder?: string; publish?: boolean }
export async function buildNewCollectionsChangeSet(q: Q, a: { title: string; reason: string; collections: CollectionInput[] }, count: (query: string) => Promise<number | null>): Promise<ChangeSet> {
  if (!a.collections?.length || a.collections.length > 20) throw new Error('collections: 1 bis 20 Einträge');
  const existing = new Map((await collectionsByIds(q, a.collections.filter(c => c.id).map(c => c.id!))).map(c => [shortId(c.id), c]));
  const items: ChangeItem[] = [], skipped: { id: string; reason: string }[] = [];
  for (const [i, c] of a.collections.entries()) {
    const key = c.id ? shortId(String(c.id)) : `neu-${i + 1}`;
    try {
      const rules = c.rules?.length ? checkRules(c.rules) : null, dis = !!c.disjunctive;
      if (c.sortOrder && !SORT_ORDERS.includes(c.sortOrder as typeof SORT_ORDERS[number])) throw new Error(`sortOrder: ${SORT_ORDERS.join(', ')}`);
      const hits = rules ? rulesQuery(rules, dis) : null, n = hits != null ? await count(hits) : null, warn: string[] = [];
      if (n === 0) warn.push('Regel trifft aktuell kein Produkt');
      if (rules && hits == null) warn.push('Trefferzahl nicht vorab prüfbar (Regelart): Shopify ermittelt die Produkte nach dem Anlegen');
      if (c.id) {
        const cur = existing.get(key); if (!cur) throw new Error('Kollektion nicht gefunden');
        if (!rules && !c.sortOrder) throw new Error('Beim Ändern: rules und/oder sortOrder (Texte über propose_category_changes)');
        if (rules && !cur.ruleSet) throw new Error('Manuelle Kollektion kann nicht in eine automatische umgewandelt werden: neue Kollektion anlegen');
        items.push({ id: key, entity: 'category', entityId: key, label: cur.title, field: 'rules', fieldLabel: 'Regel/Sortierung', before: `${cur.ruleSet ? ruleText(cur.ruleSet.rules, cur.ruleSet.appliedDisjunctively) : 'manuell'} · ${SORT_DE[cur.sortOrder] ?? cur.sortOrder}`,
          after: `${rules ? ruleText(rules, dis) : cur.ruleSet ? ruleText(cur.ruleSet.rules, cur.ruleSet.appliedDisjunctively) : 'manuell'} · ${SORT_DE[c.sortOrder ?? cur.sortOrder]}${n != null ? ` · ${n} Treffer` : ''}`,
          afterRaw: { id: cur.id, ...(rules ? { ruleSet: { appliedDisjunctively: dis, rules } } : {}), ...(c.sortOrder ? { sortOrder: c.sortOrder } : {}) }, warn });
        continue;
      }
      const name = stripHtml(c.name); if (!name) throw new Error('name fehlt');
      if (rules && c.productIds?.length) throw new Error('Entweder rules (automatisch) oder productIds (manuell)');
      const products = c.productIds?.length ? await productsByIds(q, c.productIds, 'id title', 50) : [];
      if (c.productIds?.length && products.length !== new Set(c.productIds.map(x => shortId(toGid('Product', x)))).size) throw new Error('Produkt(e) nicht gefunden');
      const input: Json = { title: name, ...(c.description ? { descriptionHtml: c.description } : {}), ...(c.handle ? { handle: c.handle } : {}), ...(c.metaTitle || c.metaDescription ? { seo: { title: c.metaTitle ?? null, description: c.metaDescription ?? null } } : {}),
        ...(rules ? { ruleSet: { appliedDisjunctively: dis, rules } } : {}), ...(products.length ? { products: products.map(p => p.id) } : {}), ...(c.sortOrder ? { sortOrder: c.sortOrder } : {}) };
      if (!c.publish) warn.push('Nicht im Online Store veröffentlicht (später mit propose_category_changes active:true)');
      items.push({ id: key, entity: 'category', label: name, field: 'create', fieldLabel: rules ? 'Neue automatische Kollektion' : 'Neue Kollektion', before: '–',
        after: rules ? `${ruleText(rules, dis)}${n != null ? ` · ${n} Treffer` : ''}` : `${products.length} Produkte: ${products.slice(0, 4).map(p => p.title).join(', ')}${products.length > 4 ? ' …' : ''}`,
        afterRaw: { input, publish: !!c.publish }, html: c.description ? { before: '', after: c.description.slice(0, 4000) } : undefined, warn });
    } catch (e) { skipped.push({ id: key, reason: `${c.name ?? key}: ${errMsg(e)}` }); }
  }
  if (!items.length) throw new Error(`Nichts anwendbar: ${skipped.map(s => s.reason).join('; ')}`);
  return { id: newId(), kind: 'collections', entity: 'category', title: a.title, reason: a.reason, items, skipped, atomic: false, noun: { one: 'Kollektion', many: 'Kollektionen' } };
}
export async function applyNewCollections(client: ShopifyClient, cs: ChangeSet, selected: Set<string>, ctx?: ApplyCtx): Promise<ApplyResult> {
  const results: ApplyResult['results'] = [], undo: UndoOp[] = [], list = cs.items.filter(i => selected.has(i.id)), tick = partialTicker(ctx, list.length, { results, undo });
  for (const it of list) {
    try {
      if (it.field === 'create') {
        const { input, publish } = it.afterRaw as { input: Json; publish: boolean };
        const q: Q = (d, v) => client.gql(d, v), ids = () => idsWhere(q, 'collections', input.handle ? qField('handle', input.handle) : qField('title', input.title));
        const r = await runCreating<Json>(client, M.collectionCreate, { input }, undo, 'collection', ids);
        undo.push(deleteOp('collection', r.collection.id));
        if (publish) await run(client, M.publish, { id: r.collection.id, input: [{ publicationId: await onlineStorePublication(client) }] });
      } else {
        const raw = it.afterRaw as Json, [c] = await collectionsByIds((d, v) => client.gql(d, v), [raw.id]);
        if (!c) throw new Error('Kollektion nicht mehr vorhanden');
        const back: Json = { id: c.id, ...(raw.ruleSet ? { ruleSet: { appliedDisjunctively: c.ruleSet.appliedDisjunctively, rules: c.ruleSet.rules.map((r: Json) => ({ column: r.column, relation: r.relation, condition: r.condition })) } } : {}), ...(raw.sortOrder ? { sortOrder: c.sortOrder } : {}) };
        await runRecording(client, M.collectionUpdate, { input: raw }, undo, reqOp('collection', c.id, M.collectionUpdate, { input: back }));
      }
      results.push({ itemId: it.id, ok: true });
    } catch (e) { results.push({ itemId: it.id, ok: false, error: errMsg(e) }); }
    finally { tick(); }
  }
  return { results, undo };
}

// =============== Produkte einer manuellen Kollektion ===============
export async function buildCollectionProductsChangeSet(q: Q, a: { title: string; reason: string; collectionId: string; add?: string[]; remove?: string[] }): Promise<ChangeSet> {
  const [c] = await collectionsByIds(q, [a.collectionId]);
  if (!c) throw new Error('Kollektion nicht gefunden');
  if (c.ruleSet) throw new Error(`„${c.title}“ ist eine automatische Kollektion (Regel: ${ruleText(c.ruleSet.rules, c.ruleSet.appliedDisjunctively)}): Produkte kommen über ihre Daten hinein (z. B. Tags mit propose_product_changes) oder die Regel ändert sich (propose_collection).`);
  const ids = [...new Set([...(a.add ?? []), ...(a.remove ?? [])].map(x => shortId(toGid('Product', x))))];
  if (!ids.length) throw new Error('add oder remove angeben');
  const prods = await productsByIds(q, ids, `id title inCollection(id: "${c.id}") variants(first: 1) { nodes { sku } }`, 50);
  const by = new Map(prods.map(p => [shortId(p.id), p]));
  const items: ChangeItem[] = [], skipped: { id: string; reason: string }[] = [];
  for (const [op, list] of [['add', a.add ?? []], ['remove', a.remove ?? []]] as const) for (const raw of list) {
    const id = shortId(toGid('Product', raw)), p = by.get(id);
    if (!p) { skipped.push({ id, reason: 'Produkt nicht gefunden' }); continue; }
    if ((op === 'add') === !!p.inCollection) { skipped.push({ id, reason: op === 'add' ? 'schon in der Kollektion' : 'nicht in der Kollektion' }); continue; }
    items.push({ id: `${op}:${id}`, entity: 'category', entityId: shortId(c.id), label: p.title, field: op, fieldLabel: op === 'add' ? 'In Kollektion aufnehmen' : 'Aus Kollektion entfernen', before: op === 'add' ? 'nicht enthalten' : 'enthalten', after: op === 'add' ? `in „${c.title}“` : 'entfernt', afterRaw: p.id,
      warn: [] });
  }
  if (!items.length) throw new Error(`Keine Änderung nötig: ${skipped.map(s => s.reason).join('; ')}`);
  return { id: newId(), kind: 'collection-products', entity: 'category', title: a.title, reason: a.reason, items, skipped, atomic: false };
}
const COLL_ORDER = 'query CollectionOrder($id: ID!, $after: String) { collection(id: $id) { sortOrder products(first: 250, after: $after, sortKey: MANUAL) { nodes { id } pageInfo { hasNextPage endCursor } } } }';
/** Positionen der gesuchten Produkte in einer manuell sortierten Kollektion (seitenweise, bis alle gefunden sind); null = nicht manuell */
async function manualPositions(client: ShopifyClient, cid: string, ids: string[]): Promise<{ id: string; newPosition: string }[] | null> {
  const want = new Set(ids), out: { id: string; newPosition: string }[] = []; let after: string | null = null, pos = 0;
  for (;;) {
    const c: Json | null = (await client.gql<Json>(COLL_ORDER, { id: cid, after })).collection;
    if (!c || c.sortOrder !== 'MANUAL') return null;
    for (const p of c.products.nodes as Json[]) { if (want.has(p.id)) out.push({ id: p.id, newPosition: String(pos) }); pos++; }
    if (out.length >= want.size || !c.products.pageInfo.hasNextPage) return out;
    after = c.products.pageInfo.endCursor;
  }
}
export async function applyCollectionProducts(client: ShopifyClient, cs: ChangeSet, selected: Set<string>, ctx?: ApplyCtx): Promise<ApplyResult> {
  const its = cs.items.filter(i => selected.has(i.id)), cid = toGid('Collection', its[0]?.entityId ?? cs.items[0].entityId!), results: ApplyResult['results'] = [], undo: UndoOp[] = [];
  const tick = partialTicker(ctx, its.length, { results, undo });
  for (const op of ['add', 'remove'] as const) {
    const list = its.filter(i => i.field === op); if (!list.length) continue;
    const ids = list.map(i => String(i.afterRaw));
    try {
      if (op === 'remove') { // manuelle Sortierung: Positionen merken; beim Rückgängig nach dem Wiederaufnehmen zurückschieben
        const moves = await manualPositions(client, cid, ids);
        if (moves?.length) undo.push(reqOp('collection', cid, M.collectionReorder, { id: cid, moves }));
      }
      await runRecording(client, op === 'add' ? M.collectionAdd : M.collectionRemove, { id: cid, productIds: ids }, undo, reqOp('collection', cid, op === 'add' ? M.collectionRemove : M.collectionAdd, { id: cid, productIds: ids }));
      list.forEach(i => results.push({ itemId: i.id, ok: true }));
    } catch (e) { list.forEach(i => results.push({ itemId: i.id, ok: false, error: errMsg(e) })); }
    finally { tick(); }
  }
  return { results, undo };
}

// =============== Produktbilder ===============
export interface ImagesArgs { title: string; reason: string; products: { productId: string; add?: { image: string; position?: number; alt?: string }[]; remove?: string[]; order?: string[]; cover?: string }[] }
interface ImagesPlan { productId: string; add: { image: string; alt?: string }[]; remove: string[]; order: string[] }
const MEDIA_SEL = 'id title media(first: 100) { nodes { id alt status ... on MediaImage { image { url altText } } } }';
const isStaged = (x: string) => x.startsWith('staged:'), isUrl = (x: string) => /^https:\/\//.test(x);

export async function buildImagesChangeSet(q: Q, a: ImagesArgs): Promise<ChangeSet> {
  if (!a.products?.length) throw new Error('products ist leer');
  if (a.products.length > MAX_ITEMS) throw new Error(`Maximal ${MAX_ITEMS} Produkte pro Änderungsset.`);
  const prods = new Map((await productsByIds(q, a.products.map(p => p.productId), MEDIA_SEL, 4)).map(p => [shortId(p.id), p]));
  const fileIds = [...new Set(a.products.flatMap(p => (p.add ?? []).map(x => x.image)).filter(x => !isStaged(x) && !isUrl(x)).map(x => shortId(toGid('MediaImage', x))))];
  const files = new Map((fileIds.length ? await mediaByIds(q, fileIds) : []).map(m => [shortId(m.id), m]));
  const items: ChangeItem[] = [], assets: ChangeAsset[] = [], skipped: { id: string; reason: string }[] = [];
  for (const req of a.products) {
    const pid = shortId(toGid('Product', req.productId)), p = prods.get(pid);
    if (!p) { skipped.push({ id: pid, reason: 'Produkt nicht gefunden' }); continue; }
    try {
      const cur: string[] = p.media.nodes.map((m: Json) => shortId(m.id)), urlOf = new Map<string, string>(p.media.nodes.map((m: Json) => [shortId(m.id), m.image?.url]));
      const add: ImagesPlan['add'] = [], remove: string[] = [], warn: string[] = [];
      for (const x of req.add ?? []) {
        if (isStaged(x.image)) { const m = stagedMeta(x.image.slice(7)); if (!m) throw new Error(`Bild ${x.image} nicht gefunden`); add.push({ image: x.image, alt: x.alt ?? m.alt ?? undefined }); assets.push({ name: p.title, url: `/staged/${m.file}`, alt: x.alt ?? m.alt ?? undefined, note: 'wird hochgeladen' }); urlOf.set(x.image, `/staged/${m.file}`); }
        else if (isUrl(x.image)) { add.push({ image: x.image, alt: x.alt }); assets.push({ name: p.title, url: x.image, alt: x.alt, note: 'wird importiert' }); urlOf.set(x.image, x.image); }
        else { const id = shortId(toGid('MediaImage', x.image)), f = files.get(id); if (!f) throw new Error(`Medium ${x.image} nicht gefunden`); if (cur.includes(id)) { warn.push(`Medium ${id} ist schon am Produkt`); continue; } add.push({ image: id }); urlOf.set(id, f.image?.url); }
      }
      for (const r of req.remove ?? []) { const id = shortId(toGid('MediaImage', r)); if (!cur.includes(id)) throw new Error(`Medium ${r} ist nicht am Produkt`); remove.push(id); }
      // Ziel-Reihenfolge: neue Bilder an position bzw. hinten, dann order, dann cover nach vorn
      let order = cur.filter(id => !remove.includes(id));
      for (const x of add) { const pos = req.add?.find(y => y.image === x.image || shortId(y.image) === x.image)?.position; order.splice(pos != null ? Math.max(0, Math.min(pos, order.length)) : order.length, 0, x.image); }
      const norm = (x: string) => (isStaged(x) || isUrl(x) ? x : shortId(toGid('MediaImage', x)));
      if (req.order?.length) { const want = req.order.map(norm).filter(x => order.includes(x)); order = [...want, ...order.filter(x => !want.includes(x))]; }
      if (req.cover) { const c = norm(req.cover); if (!order.includes(c)) throw new Error(`Titelbild ${req.cover} ist nicht unter den Bildern`); order = [c, ...order.filter(x => x !== c)]; }
      if (!add.length && !remove.length && order.join() === cur.join()) { skipped.push({ id: pid, reason: 'keine Änderung' }); continue; }
      if (remove.includes(cur[0]) || (order[0] !== cur[0] && cur.length)) warn.push('Titelbild ändert sich');
      if (!order.length) warn.push('Produkt hat danach kein Bild');
      // „Text vergleichen“ zeigt Text, kein Markup: Dateinamen in Reihenfolge (neue Bilder stehen zusätzlich als assets in der Karte)
      const show = (ids: string[]) => ids.map((id, i) => `${i + 1}. ${fileName(urlOf.get(id)) ?? id}`).join('\n');
      items.push({ id: pid, entity: 'product', entityId: pid, label: p.title, field: 'images', fieldLabel: 'Bilder', before: `${cur.length} Bilder`, after: `${order.length} Bilder (${[add.length && `+${add.length}`, remove.length && `−${remove.length}`].filter(Boolean).join(', ') || 'neu sortiert'})`,
        afterRaw: { productId: p.id, add, remove, order } satisfies ImagesPlan, html: { before: show(cur), after: show(order) }, warn });
    } catch (e) { skipped.push({ id: pid, reason: errMsg(e) }); }
  }
  if (!items.length) throw new Error(`Nichts anwendbar: ${skipped.map(s => s.reason).join('; ')}`);
  return { id: newId(), kind: 'product-media', entity: 'product', title: a.title, reason: a.reason, items, assets, skipped, atomic: false };
}

const fileName = (u: string | undefined) => (u ? u.split('/').pop()?.split('?')[0] || u : undefined);
async function mediaIdsOf(client: ShopifyClient, productId: string): Promise<string[]> {
  const r = await client.gql<Json>('query ProductMedia($id: ID!) { product(id: $id) { media(first: 250) { nodes { id } } } }', { id: productId });
  if (!r.product) throw new Error('Produkt nicht mehr vorhanden');
  return r.product.media.nodes.map((m: Json) => m.id);
}
const moves = (ids: string[]) => ids.map((id, i) => ({ id, newPosition: String(i) }));

/** Bilder eines Produkts ändern. Rückgängig-Schritte landen SOFORT nach jedem Schritt in undo (auch wenn ein späterer scheitert). */
export async function applyImages(client: ShopifyClient, plan: ImagesPlan, undo: UndoOp[]): Promise<void> {
  const pid = plan.productId, before = await mediaIdsOf(client, pid);
  undo.push(reqOp('product-media', pid, M.reorderMedia, { id: pid, moves: moves(before) })); // läuft beim Rückgängig zuletzt
  const created = new Map<string, string>(); // image-Schlüssel → neue Medien-GID
  const toCreate = plan.add.filter(x => isStaged(x.image) || isUrl(x.image)), refs = plan.add.filter(x => !isStaged(x.image) && !isUrl(x.image));
  if (toCreate.length) {
    const media: Json[] = [];
    for (const x of toCreate) {
      if (isStaged(x.image)) { const up = await uploadStagedImage(client, x.image.slice(7)); media.push({ originalSource: up.originalSource, mediaContentType: 'IMAGE', alt: x.alt ?? up.alt }); }
      else media.push({ originalSource: x.image, mediaContentType: 'IMAGE', alt: x.alt ?? '' });
    }
    const note = (ids: string[]) => { const fresh = ids.filter(id => !before.includes(id)); toCreate.forEach((x, i) => { if (fresh[i]) created.set(x.image, fresh[i]); }); fresh.forEach(id => undo.push(deleteOp('file', id))); };
    let r: Json;
    try { r = await run<Json>(client, M.productMediaAdd, { product: { id: pid }, media }); }
    catch (e) { // Ausgang unklar (Netz, Zeitlimit): neu angelegte Medien trotzdem zum Löschen vormerken
      if (!isUserError(e)) { try { note(await mediaIdsOf(client, pid)); } catch { /* nicht lesbar */ } }
      throw e;
    }
    note((r.product?.media?.nodes ?? []).map((m: Json) => m.id));
  }
  if (refs.length) {
    const ids = refs.map(x => toGid('MediaImage', x.image));
    await runRecording(client, M.fileUpdate, { files: ids.map(id => ({ id, referencesToAdd: [pid] })) }, undo, reqOp('product-media', pid, M.fileUpdate, { files: ids.map(id => ({ id, referencesToRemove: [pid] })) }));
  }
  if (plan.remove.length) {
    const ids = plan.remove.map(x => toGid('MediaImage', x));
    await runRecording(client, M.fileUpdate, { files: ids.map(id => ({ id, referencesToRemove: [pid] })) }, undo, reqOp('product-media', pid, M.fileUpdate, { files: ids.map(id => ({ id, referencesToAdd: [pid] })) }));
  }
  const want = plan.order.map(x => created.get(x) ?? (isStaged(x) || isUrl(x) ? null : toGid('MediaImage', x))).filter((x): x is string => !!x);
  const now = await mediaIdsOf(client, pid);
  const target = [...want.filter(id => now.includes(id)), ...now.filter(id => !want.includes(id))];
  if (target.join() !== now.join()) await run(client, M.reorderMedia, { id: pid, moves: moves(target) });
}
export async function applyImagesSet(client: ShopifyClient, cs: ChangeSet, selected: Set<string>, ctx?: ApplyCtx): Promise<ApplyResult> {
  const results: ApplyResult['results'] = [], undo: UndoOp[] = [], list = cs.items.filter(i => selected.has(i.id)), tick = partialTicker(ctx, list.length, { results, undo });
  await pool(list, WRITE_CONCURRENCY, async it => {
    // je Produkt eigene Liste (parallel), danach am Stück anhängen: Reihenfolge der Schritte eines Produkts bleibt zusammen
    const mine: UndoOp[] = [];
    try { await applyImages(client, it.afterRaw as ImagesPlan, mine); results.push({ itemId: it.id, ok: true }); }
    catch (e) { results.push({ itemId: it.id, ok: false, error: errMsg(e) }); }
    finally { undo.push(...mine); tick(); }
  });
  return { results, undo };
}

// =============== Alt-Texte ===============
const pathKey = (u: string) => { try { return new URL(u, 'http://x').pathname; } catch { return u; } };
export async function buildAltTextChangeSet(q: Q, a: { title: string; reason: string; images: { mediaId: string; alt: string }[] }, viewed: Set<string> | null): Promise<ChangeSet> {
  if (!a.images?.length) throw new Error('images ist leer');
  if (a.images.length > MAX_ITEMS) throw new Error(`Maximal ${MAX_ITEMS} Bilder pro Änderungsset.`);
  const media = new Map((await mediaByIds(q, a.images.map(i => i.mediaId))).map(m => [shortId(m.id), m]));
  const seenPaths = new Set([...(viewed ?? [])].map(pathKey));
  const items: ChangeItem[] = [], skipped: { id: string; reason: string }[] = []; let unchanged = 0;
  for (const im of a.images) {
    const id = shortId(toGid('MediaImage', im.mediaId)), m = media.get(id);
    if (!m) { skipped.push({ id, reason: 'Medium nicht gefunden' }); continue; }
    if (viewed && !viewed.has(id) && !viewed.has(m.id) && !(m.image?.url && seenPaths.has(pathKey(m.image.url)))) { skipped.push({ id, reason: 'Bild nicht mit view_image angesehen' }); continue; }
    try {
      const { alt, warn } = checkAlt(im.alt);
      const cur = m.alt ?? m.image?.altText ?? '';
      if (cur === alt) { unchanged++; continue; }
      items.push({ id, entity: 'media', entityId: id, label: fileName(m.image?.url) ?? id, field: 'alt', fieldLabel: 'Alt-Text', before: cur || '–', after: alt, afterRaw: alt, warn });
    } catch (e) { skipped.push({ id, reason: errMsg(e) }); }
  }
  if (!items.length) throw new Error(`Keine Änderung nötig bzw. nichts anwendbar (${unchanged} unverändert${skipped.length ? `, übersprungen: ${skipped.slice(0, 3).map(s => `${s.id}: ${s.reason}`).join('; ')}` : ''})`);
  return { id: newId(), kind: 'alt-texts', entity: 'media', title: a.title, reason: a.reason, items, skipped, unchanged, atomic: false, noun: { one: 'Bild', many: 'Bilder' } };
}
export async function applyAltTexts(client: ShopifyClient, cs: ChangeSet, selected: Set<string>, ctx?: ApplyCtx): Promise<ApplyResult> {
  const its = cs.items.filter(i => selected.has(i.id)), results: ApplyResult['results'] = [], undo: UndoOp[] = [], tick = partialTicker(ctx, its.length, { results, undo });
  for (let i = 0; i < its.length; i += 50) {
    const chunk = its.slice(i, i + 50);
    try {
      const cur = new Map((await mediaByIds((d, v) => client.gql(d, v), chunk.map(c => c.entityId!))).map(m => [shortId(m.id), m]));
      const list = chunk.filter(c => cur.has(c.entityId!));
      chunk.filter(c => !cur.has(c.entityId!)).forEach(c => results.push({ itemId: c.id, ok: false, error: 'Medium nicht mehr vorhanden' }));
      if (!list.length) continue;
      await runRecording(client, M.fileUpdate, { files: list.map(c => ({ id: toGid('MediaImage', c.entityId!), alt: c.afterRaw })) }, undo,
        reqOp('media', 'alt', M.fileUpdate, { files: list.map(c => ({ id: toGid('MediaImage', c.entityId!), alt: cur.get(c.entityId!)!.alt ?? '' })) }));
      list.forEach(c => results.push({ itemId: c.id, ok: true }));
    } catch (e) { chunk.forEach(c => results.push({ itemId: c.id, ok: false, error: errMsg(e) })); }
    finally { tick(); }
  }
  return { results, undo };
}

// =============== Handles (SEO-URLs) mit Weiterleitung ===============
/** Handle aus Freitext oder Pfad (/products/<handle>) */
export const slugify = (s: string) => slug(String(s ?? '').replace(/^.*\/(products|collections|pages)\//i, ''), 255);
type HandleEntity = 'product' | 'category' | 'page';
const PREFIX: Record<HandleEntity, string> = { product: 'products', category: 'collections', page: 'pages' };
const TYPE: Record<HandleEntity, string> = { product: 'Product', category: 'Collection', page: 'Page' };
export async function buildHandlesChangeSet(q: Q, a: { title: string; reason: string; changes: { entity: HandleEntity; id: string; slug: string }[] }): Promise<ChangeSet> {
  if (!a.changes?.length) throw new Error('changes ist leer');
  if (a.changes.length > MAX_ITEMS) throw new Error(`Maximal ${MAX_ITEMS} URLs pro Änderungsset.`);
  const items: ChangeItem[] = [], skipped: { id: string; reason: string }[] = [];
  const cur = new Map<string, Json>();
  for (const e of ['product', 'category', 'page'] as HandleEntity[]) {
    const ids = a.changes.filter(c => c.entity === e).map(c => c.id); if (!ids.length) continue;
    const rows = e === 'product' ? await productsByIds(q, ids, 'id title handle status', 50) : e === 'category' ? await collectionsByIds(q, ids, 'id title handle') : await pagesByIds(q, ids);
    for (const r of rows) cur.set(`${e}:${shortId(r.id)}`, r);
  }
  // vergebene Handles je Art gebündelt prüfen (50 je Abfrage statt eine Abfrage je Zeile)
  const taken = new Map<string, string>();
  for (const e of ['product', 'category', 'page'] as HandleEntity[]) {
    const slugs = [...new Set(a.changes.filter(c => c.entity === e).map(c => slugify(c.slug)).filter(Boolean))];
    for (let i = 0; i < slugs.length; i += 50) {
      const chunk = slugs.slice(i, i + 50);
      const r = await q<Json>(`query Taken($first: Int!, $query: String) { ${PREFIX[e]}(first: $first, query: $query) { nodes { id handle } } }`, { first: chunk.length, query: chunk.map(h => qField('handle', h)).join(' OR ') });
      for (const n of r[PREFIX[e]].nodes as Json[]) taken.set(`${e}:${n.handle}`, n.id);
    }
  }
  const wanted = new Set<string>();
  for (const c of a.changes) {
    const key = `${c.entity}:${shortId(String(c.id))}`, r = cur.get(key);
    if (!r) { skipped.push({ id: key, reason: 'nicht gefunden' }); continue; }
    const slug = slugify(c.slug);
    if (!slug) { skipped.push({ id: key, reason: 'Slug leer' }); continue; }
    if (slug === r.handle) { skipped.push({ id: key, reason: 'unverändert' }); continue; }
    if (wanted.has(`${c.entity}:${slug}`)) { skipped.push({ id: key, reason: `Slug ${slug} doppelt im Set` }); continue; }
    const owner = taken.get(`${c.entity}:${slug}`);
    if (owner && owner !== r.id) { skipped.push({ id: key, reason: `/${PREFIX[c.entity]}/${slug} ist schon vergeben` }); continue; }
    wanted.add(`${c.entity}:${slug}`);
    items.push({ id: key, entity: c.entity === 'page' ? 'landing-page' : c.entity, entityId: shortId(r.id), label: r.title, field: 'handle', fieldLabel: 'URL (Handle)', before: `/${PREFIX[c.entity]}/${r.handle}`, after: `/${PREFIX[c.entity]}/${slug}`,
      afterRaw: { entity: c.entity, id: r.id, handle: slug }, warn: [`Weiterleitung /${PREFIX[c.entity]}/${r.handle} → /${PREFIX[c.entity]}/${slug} wird angelegt`, ...(c.slug !== slug ? [`Slug normalisiert (${c.slug} → ${slug})`] : [])] });
  }
  if (!items.length) throw new Error(`Nichts anwendbar: ${skipped.map(s => `${s.id}: ${s.reason}`).join('; ')}`);
  return { id: newId(), kind: 'handles', entity: 'seo-url', title: a.title, reason: a.reason, items, skipped, atomic: false, noun: { one: 'URL', many: 'URLs' } };
}
const REDIRECTS = 'query Redirects($query: String) { urlRedirects(first: 50, query: $query) { nodes { id path target } } }';
/** Handle setzen (Shopify legt die Weiterleitung alt → neu an). Rückgängig-Schritte landen in undo, auch wenn die Antwort verloren geht. */
export async function applyHandle(client: ShopifyClient, raw: { entity: HandleEntity; id: string; handle: string }, undo: UndoOp[]): Promise<void> {
  const e = raw.entity, q: Q = (d, v) => client.gql(d, v);
  const [r] = e === 'product' ? await productsByIds(q, [raw.id], 'id handle', 1) : e === 'category' ? await collectionsByIds(q, [raw.id], 'id handle') : await pagesByIds(q, [raw.id]);
  if (!r) throw new Error('Datensatz nicht mehr vorhanden');
  const oldPath = `/${PREFIX[e]}/${r.handle}`, redirects = async () => (await client.gql<Json>(REDIRECTS, { query: qField('path', oldPath) })).urlRedirects.nodes as Json[];
  const pre = new Set((await redirects()).map(x => x.id));
  const set = (h: string, redirect: boolean): [string, Json] => e === 'product' ? [M.productUpdate, { product: { id: r.id, handle: h, redirectNewHandle: redirect } }]
    : e === 'category' ? [M.collectionUpdate, { input: { id: r.id, handle: h, redirectNewHandle: redirect } }] : [M.pageUpdate, { id: r.id, page: { handle: h, redirectNewHandle: redirect } }];
  const [mq, mv] = set(raw.handle, true), [bq, bv] = set(r.handle, false);
  // neu angelegte Weiterleitung(en) alt → neu: beim Rückgängig zuerst löschen, dann Handle zurück
  const noteRedirects = async () => { for (const x of await redirects()) if (!pre.has(x.id) && x.path === oldPath) undo.push(deleteOp('redirect', x.id)); };
  try { await runRecording(client, mq, mv, undo, reqOp(e, r.id, bq, bv)); }
  catch (err) { if (!isUserError(err)) { try { await noteRedirects(); } catch { /* nicht lesbar */ } } throw err; }
  await noteRedirects();
}
export async function applyHandles(client: ShopifyClient, cs: ChangeSet, selected: Set<string>, ctx?: ApplyCtx): Promise<ApplyResult> {
  const results: ApplyResult['results'] = [], undo: UndoOp[] = [], list = cs.items.filter(i => selected.has(i.id)), tick = partialTicker(ctx, list.length, { results, undo });
  for (const it of list) {
    try { await applyHandle(client, it.afterRaw as { entity: HandleEntity; id: string; handle: string }, undo); results.push({ itemId: it.id, ok: true }); }
    catch (e) { results.push({ itemId: it.id, ok: false, error: errMsg(e) }); }
    finally { tick(); }
  }
  return { results, undo };
}
export { TYPE as HANDLE_TYPES };

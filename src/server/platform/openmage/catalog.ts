import 'server-only';
// OpenMage: change sets for products, categories, translations, URL keys and category assignments (build + executor).
// Building reads via the guarded read client; the executor re-reads the before values and writes with the privileged client.
import type { ChangeItem, ChangeSet, UndoOp } from '@/lib/protocol';
import { assertFresh, isStale, STALE } from '../../changes';
import { applyEach, errMsg, MAX_ITEMS, newIdSafe, partialTicker, pool, resolvePrice, WRITE_CONCURRENCY, type ApplyCtx, type ApplyResult, type PriceSpec } from './kit';
import { skuPath, type OmClient } from './client';
import { basisWord, day, isActive, money, mrec, omAttr, omStr, plain, planPrice, priceOf, priceText, priceUndo, productLabel, same, stripTitleAffixes, urlKey, VISIBILITY, VISIBILITY_IN, FROM_KIDS, SIMPLE_TYPES, type OmCategory, type OmProduct, type OmRecord, type PriceWrite } from './map';
import { LIST_FIELDS, parseRef, pickRef, type OmReader } from './reader';
import { getCategory, getProduct, reg, reqOp, writeScoped, writeStore } from './write';

type Kind = 'str' | 'html' | 'price' | 'date' | 'int' | 'bool' | 'visibility' | 'num';
interface FieldDef { label: string; kind: Kind; attr?: string; /** global = website/global attribute (not per store view) */ global?: boolean }
/** Fields for propose_product_changes (names as in Shopware/Magento) → OpenMage attribute */
export const OM_PRODUCT_FIELDS: Record<string, FieldDef> = {
  name: { label: 'Name', kind: 'str', attr: 'name' }, description: { label: 'Beschreibung', kind: 'html', attr: 'description' }, shortDescription: { label: 'Kurzbeschreibung', kind: 'html', attr: 'short_description' },
  metaTitle: { label: 'Meta-Title', kind: 'str', attr: 'meta_title' }, metaDescription: { label: 'Meta-Description', kind: 'str', attr: 'meta_description' }, keywords: { label: 'Meta-Keywords', kind: 'str', attr: 'meta_keyword' },
  price: { label: 'Preis', kind: 'price' }, listPrice: { label: 'Streichpreis', kind: 'price' }, specialFromDate: { label: 'Sonderpreis ab', kind: 'date' }, specialToDate: { label: 'Sonderpreis bis', kind: 'date' },
  stock: { label: 'Bestand', kind: 'int' }, active: { label: 'Aktiv', kind: 'bool', attr: 'status' }, visibility: { label: 'Sichtbarkeit', kind: 'visibility', attr: 'visibility' }, weight: { label: 'Gewicht', kind: 'num', attr: 'weight', global: true },
};
export const OM_CATEGORY_FIELDS: Record<string, FieldDef> = {
  name: { label: 'Name', kind: 'str', attr: 'name' }, description: { label: 'Beschreibung', kind: 'html', attr: 'description' },
  metaTitle: { label: 'Meta-Title', kind: 'str', attr: 'meta_title' }, metaDescription: { label: 'Meta-Description', kind: 'str', attr: 'meta_description' }, keywords: { label: 'Meta-Keywords', kind: 'str', attr: 'meta_keywords' },
  active: { label: 'Aktiv', kind: 'bool', attr: 'is_active' },
};
/** Custom product attributes (propose_product_changes fields.attributes): allowed input types */
const ATTR_INPUTS = new Set(['text', 'textarea', 'select', 'boolean']);
const PRICE_KEYS = ['price', 'listPrice', 'specialFromDate', 'specialToDate'];
const cut = (t: unknown, n = 220) => { const s = plain(t); return s.length > n ? `${s.slice(0, n)}…` : s || '–'; };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validate(def: FieldDef, v: unknown): unknown {
  switch (def.kind) {
    case 'str': case 'html': if (typeof v !== 'string') throw new Error(`${def.label}: Text erwartet`); if (def.kind === 'str' && v.length > 255) throw new Error(`${def.label}: max. 255 Zeichen`); if (def.attr === 'name' && !v.trim()) throw new Error('Name darf nicht leer sein'); return v;
    case 'int': if (!Number.isInteger(v) || (v as number) < 0) throw new Error(`${def.label}: ganze Zahl ≥ 0 erwartet`); return v;
    case 'num': if (typeof v !== 'number' || !(v >= 0)) throw new Error(`${def.label}: Zahl ≥ 0 erwartet`); return v;
    case 'bool': if (typeof v !== 'boolean') throw new Error(`${def.label}: true/false erwartet`); return v;
    case 'visibility': { const n = typeof v === 'number' ? v : VISIBILITY_IN[String(v)]; if (![1, 2, 3, 4].includes(n)) throw new Error('Sichtbarkeit: none, catalog, search oder both'); return n; }
    case 'date': if (v !== null && !(typeof v === 'string' && DATE_RE.test(v))) throw new Error(`${def.label}: Datum JJJJ-MM-TT oder null`); return v;
  }
  return v;
}
/** Meta title without the store view's theme suffix/prefix (OpenMage adds it itself) */
const normTitle = (def: FieldDef, v: unknown, view: Parameters<typeof stripTitleAffixes>[1]) => (def.attr === 'meta_title' && typeof v === 'string' ? stripTitleAffixes(v, view) : v);
const shown = (def: FieldDef, v: unknown) => (def.kind === 'bool' ? (v ? 'ja' : 'nein') : def.kind === 'visibility' ? VISIBILITY[Number(v)] ?? String(v ?? '–') : def.kind === 'int' || def.kind === 'num' ? String(v ?? '–') : cut(v));
const catActive = (c: OmRecord) => { const v = omAttr(c, 'is_active'); return v === true || Number(v) === 1; };

export interface ProposeArgs { title: string; reason: string; changes: { id: string; fields: Record<string, unknown> }[] }
/** Payload of the products/categories sets: store view at build time + SKU per product ID (OpenMage writes by SKU) */
export interface CatalogPayload { store: string; skus?: Record<string, string> }

/**
 * Load the proposals' products (references: id:…, sku:…, number = ID or SKU, otherwise SKU) as list entries with content/SEO fields,
 * key = reference; optionally with gallery, with details also the detail (custom attributes). A number with two different hits throws "Mehrdeutig" (ambiguous).
 */
export async function loadProducts(ro: OmReader, refs: string[], o: { details?: boolean; store?: string; images?: boolean } = {}): Promise<Map<string, OmProduct>> {
  const byRef = new Map<string, OmProduct>(), want = refs.map(ref => ({ ref, ...parseRef(ref) }));
  const opt = { fields: LIST_FIELDS, store: o.store, images: o.images };
  const [byId, bySku] = await Promise.all([ro.productsByIds(want.flatMap(w => (w.id ? [w.id] : [])), opt), ro.productsBySkus(want.flatMap(w => (w.sku ? [w.sku] : [])), opt)]);
  const idMap = new Map(byId.map(p => [String(p.id), p])), skuMap = new Map(bySku.map(p => [p.sku, p]));
  for (const w of want) { const p = pickRef(w.ref, w.id ? idMap.get(w.id) : null, w.sku ? skuMap.get(w.sku) : null); if (p) byRef.set(w.ref, p); }
  if (o.details) for (const [k, p] of byRef) { const d = await ro.product(p.sku, o.store); if (d) byRef.set(k, d); }
  return byRef;
}

// ================= Products =================
export async function buildProductChangeSet(ro: OmReader, { title, reason, changes }: ProposeArgs): Promise<{ cs: ChangeSet; payload: CatalogPayload }> {
  if (!changes?.length) throw new Error('changes ist leer');
  if (changes.length > MAX_ITEMS) throw new Error(`Maximal ${MAX_ITEMS} Produkte pro Änderungsset, bitte aufteilen.`);
  const refs = [...new Set(changes.map(c => String(c.id)))], needDetails = changes.some(c => c.fields && typeof c.fields.attributes === 'object');
  const byRef = await loadProducts(ro, refs, { details: needDetails });
  const basis = await ro.priceBasis(), store = await ro.store(), view = await ro.storeView(store).catch(() => undefined);
  const items: ChangeItem[] = [], skipped: { id: string; reason: string }[] = [], skus: Record<string, string> = {};
  let unchanged = 0;
  for (const ch of changes) {
    const p = byRef.get(String(ch.id));
    if (!p) { skipped.push({ id: String(ch.id), reason: 'nicht gefunden' }); continue; }
    const id = String(p.id), label = productLabel(p); skus[id] = p.sku;
    const f = { ...(ch.fields ?? {}) }, push = (field: string, fieldLabel: string, before: string, after: string, afterRaw: unknown, warn: string[] = [], html?: ChangeItem['html'], beforeRaw?: unknown) => items.push({ id: `${id}:${field}`, entity: 'product', entityId: id, label, field, fieldLabel, before, after, afterRaw, ...(beforeRaw !== undefined ? { beforeRaw } : {}), warn, ...(html ? { html } : {}) });
    // Prices: price/listPrice/special price period make up ONE row with the OpenMage values
    if (PRICE_KEYS.some(k => k in f)) {
      try {
        if (FROM_KIDS.has(String(p.type_id))) throw new Error(`Preis eines ${p.type_id}-Produkts kommt aus seinen Einzelprodukten, dort ändern`);
        const s = priceOf(p);
        const want: { price?: number; listPrice?: number | null; from?: string | null; to?: string | null } = {};
        if ('price' in f) { const v = resolvePrice(s.selling, f.price as PriceSpec); if (v == null) throw new Error('Preis kann nicht entfernt werden'); want.price = v; }
        if ('listPrice' in f) want.listPrice = resolvePrice(s.list, f.listPrice as PriceSpec);
        if ('specialFromDate' in f) want.from = validate(OM_PRODUCT_FIELDS.specialFromDate, f.specialFromDate) as string | null;
        if ('specialToDate' in f) want.to = validate(OM_PRODUCT_FIELDS.specialToDate, f.specialToDate) as string | null;
        if ((want.price != null && !(want.price >= 0)) || (want.listPrice != null && !(want.listPrice >= 0))) throw new Error('Preis: ungültiger Wert');
        const { write, notes } = planPrice(s, want);
        if (!Object.keys(write).length) unchanged++;
        else {
          const next = { selling: want.price ?? s.selling, list: want.listPrice === undefined ? s.list : want.listPrice }, warn = [...notes];
          if (next.selling === 0) warn.push('Preis 0 €');
          if (s.selling && next.selling != null) { const d = ((next.selling - s.selling) / s.selling) * 100; if (Math.abs(d) >= 30) warn.push(`Preisänderung ${d > 0 ? '+' : ''}${d.toFixed(0)} %`); }
          const period = write.special_to_date || write.special_from_date ? ` · Zeitraum ${write.special_from_date ?? s.from ?? '…'} bis ${write.special_to_date ?? s.to ?? '…'}` : '';
          const expect = priceUndo(mrec(p), Object.keys(write) as (keyof PriceWrite)[]);
          push('price', `Preis ${basisWord(basis)} (Streichpreis)`, priceText(s, basis), `${priceText(next, basis)}${period}`, { write, expect }, warn, undefined, expect);
        }
      } catch (e) { skipped.push({ id, reason: `Preis: ${errMsg(e)}` }); }
      for (const k of PRICE_KEYS) delete f[k];
    }
    if (f.attributes && typeof f.attributes === 'object') {
      for (const [code, raw] of Object.entries(f.attributes as Record<string, unknown>)) {
        try {
          const def = await ro.attribute(code);
          if (!def || !def.is_user_defined || !ATTR_INPUTS.has(String(def.input)) || def.writable === false) throw new Error('Attribut nicht vorhanden oder nicht über Lotse änderbar');
          const opts = ((def.options ?? []) as { label: string; value: unknown }[]).filter(o => o.value !== '' && o.value != null), curRaw = omAttr(p, code);
          let v: unknown = raw, shownAfter = String(raw);
          if (def.input === 'select') { const o = opts.find(x => x.label.toLowerCase() === String(raw).trim().toLowerCase() || String(x.value) === String(raw)); if (!o) throw new Error(`Wert „${raw}“ gibt es nicht (vorhanden: ${opts.map(x => x.label).slice(0, 15).join(', ')})`); v = o.value; shownAfter = o.label; }
          else if (def.input === 'boolean') { if (typeof raw !== 'boolean') throw new Error('true/false erwartet'); v = raw ? 1 : 0; shownAfter = raw ? 'ja' : 'nein'; }
          else if (typeof raw !== 'string') throw new Error('Text erwartet');
          if (same(curRaw, v)) { unchanged++; continue; }
          const before = def.input === 'select' ? opts.find(x => String(x.value) === String(curRaw))?.label ?? '–' : def.input === 'boolean' ? (curRaw == null ? '–' : Number(curRaw) === 1 ? 'ja' : 'nein') : cut(curRaw);
          push(`attr:${code}`, String(def.label ?? code), before, cut(shownAfter), { attr: code, value: v, scope: def.scope ?? 'store' }, [], undefined, curRaw ?? null);
        } catch (e) { skipped.push({ id, reason: `${code}: ${errMsg(e)}` }); }
      }
      delete f.attributes;
    }
    for (const [field, raw] of Object.entries(f)) {
      const def = OM_PRODUCT_FIELDS[field];
      if (!def) { skipped.push({ id, reason: `Feld "${field}" nicht erlaubt` }); continue; }
      try {
        let v = normTitle(def, validate(def, raw), view);
        if (field === 'stock') {
          if (!SIMPLE_TYPES.has(String(p.type_id))) throw new Error(`${p.type_id}-Produkte haben keinen eigenen Bestand`);
          const cur = p.qty == null ? (p.stock?.qty ?? null) : Number(p.qty);
          if (cur === v) { unchanged++; continue; }
          push('stock', def.label, cur == null ? '–' : String(cur), String(v), { quantity: v }, cur != null && cur > 0 && v === 0 ? ['Bestand auf 0'] : [], undefined, cur);
          continue;
        }
        if (field === 'active') v = v ? 1 : 2;
        const cur = omAttr(p, def.attr!);
        if (same(cur, v)) { unchanged++; continue; }
        const warn: string[] = [];
        if (field === 'active' && v === 2) warn.push('Wird deaktiviert');
        if (field === 'visibility' && v === 1) warn.push('Nicht mehr einzeln im Shop sichtbar');
        const before = field === 'active' ? (isActive(p) ? 'ja' : 'nein') : shown(def, cur), after = field === 'active' ? (v === 1 ? 'ja' : 'nein') : shown(def, v);
        push(field, def.label, before, after, v, warn, def.kind === 'html' ? { before: String(cur ?? '').slice(0, 4000), after: String(v).slice(0, 4000) } : undefined, cur ?? null);
      } catch (e) { skipped.push({ id, reason: `${field}: ${errMsg(e)}` }); }
    }
  }
  if (!items.length) throw new Error(`Keine Änderung nötig bzw. nichts anwendbar (${unchanged} unverändert, ${skipped.length} übersprungen: ${skipped.slice(0, 3).map(s => s.reason).join('; ')})`);
  if (items.some(i => i.field === 'price')) items.push({ id: 'info:preis', entity: 'info', label: 'Hinweis OpenMage-Preise', fieldLabel: '', before: '', after: `OpenMage zeigt den regulären Preis durchgestrichen, solange ein niedrigerer Sonderpreis gilt. Lotse setzt dafür price (Streichpreis) und special_price (Verkaufspreis). Alle Preise ${basisWord(basis)}, wie im Admin eingegeben${basis === 'net' ? '; der Kunde zahlt zusätzlich die MwSt.' : ''}.`, warn: [] });
  return { cs: { id: newIdSafe(), kind: 'products', entity: 'product', title, reason, items, skipped, unchanged, atomic: false }, payload: { store, skus } };
}

/**
 * Price fields unchanged since the proposal? (otherwise error, please propose again). Compared in the proposal's scope
 * (store view from the settings), because that is where `expect` was read; with website prices the global record may differ.
 */
export async function assertPriceUnchanged(c: OmClient, sku: string, store: string, expect: PriceWrite, what = 'Produkt'): Promise<OmProduct> {
  const cur = await getProduct(c, sku, store);
  if (!cur) throw new Error(`${what} nicht mehr vorhanden`);
  const now = priceUndo(mrec(cur), Object.keys(expect) as (keyof PriceWrite)[]) as Record<string, unknown>, exp = expect as Record<string, unknown>;
  if (Object.keys(exp).some(k => !same(day(now[k]), day(exp[k])))) throw new Error('Preis wurde inzwischen in OpenMage geändert, bitte neu vorschlagen');
  return cur;
}
/** Set stock with exact undo (qty + is_in_stock) */
export async function writeStock(c: OmClient, sku: string, quantity: number): Promise<UndoOp> {
  const cur = await c.req('GET', `/v1/products/${skuPath(sku)}/stock`) as { qty: number; is_in_stock: boolean } | null;
  await c.req('PUT', `/v1/products/${skuPath(sku)}/stock`, { qty: quantity, is_in_stock: quantity > 0 ? true : !!cur?.is_in_stock });
  return reqOp('stock', sku, 'PUT', `/v1/products/${skuPath(sku)}/stock`, { qty: Number(cur?.qty ?? 0), is_in_stock: !!cur?.is_in_stock });
}

type ApplyPiece = { undo: UndoOp[]; failed?: { id: string; error: string }[] };

/** Fresh attribute value. Price and stock have their own checks. No check without beforeRaw. */
function splitStale(its: ChangeItem[], freshOf: (it: ChangeItem) => unknown): { live: ChangeItem[]; failed: { id: string; error: string }[] } {
  const live: ChangeItem[] = [], failed: { id: string; error: string }[] = [];
  for (const it of its) {
    if (it.beforeRaw === undefined || !it.field || it.field === 'price' || it.field === 'stock') { live.push(it); continue; }
    try { assertFresh(it.fieldLabel, freshOf(it), it.beforeRaw); live.push(it); }
    catch (e) { failed.push({ id: it.id, error: errMsg(e) }); }
  }
  return { live, failed };
}
const withFailed = (e: unknown, undo: UndoOp[], failed: { id: string; error: string }[]): never => {
  const prev = (e as { undo?: UndoOp[] }).undo;
  throw Object.assign(e instanceof Error ? e : new Error(String(e)), { undo: !prev?.length || prev === undo ? undo : [...undo, ...prev], ...(failed.length ? { failed } : {}) });
};

async function applyProduct(c: OmClient, store: string, sku: string, its: ChangeItem[]): Promise<ApplyPiece> {
  const fresh = await getProduct(c, sku, store);
  if (!fresh) throw new Error('Produkt nicht mehr vorhanden');
  const { live, failed } = splitStale(its, it => {
    const code = it.field!.startsWith('attr:') ? (it.afterRaw as { attr: string }).attr : OM_PRODUCT_FIELDS[it.field!]?.attr;
    return code ? omAttr(fresh, code) : undefined;
  });
  const scoped: Record<string, unknown> = {}, global: Record<string, unknown> = {}, undo: UndoOp[] = [];
  for (const it of live) {
    const def = it.field ? OM_PRODUCT_FIELDS[it.field] : undefined;
    if (it.field?.startsWith('attr:')) { const a = it.afterRaw as { attr: string; value: unknown; scope: string }; (a.scope === 'global' || a.scope === 'website' ? global : scoped)[a.attr] = a.value; }
    else if (def?.attr && it.field !== 'stock') (def.global ? global : scoped)[def.attr] = it.afterRaw;
  }
  const pi = live.find(i => i.field === 'price');
  if (pi) {
    const { write, expect } = pi.afterRaw as { write: PriceWrite; expect: PriceWrite };
    try { await assertPriceUnchanged(c, sku, store, expect); Object.assign(global, write); }
    catch (e) {
      const msg = errMsg(e);
      if (!/inzwischen/.test(msg)) throw e;
      failed.push({ id: pi.id, error: msg });
    }
  }
  try {
    if (Object.keys(scoped).length || Object.keys(global).length) undo.push(...await writeScoped(c, 'product', sku, store, scoped, global));
  } catch (e) { return withFailed(e, undo, failed); }
  const si = live.find(i => i.field === 'stock');
  if (si) {
    try {
      if (si.beforeRaw !== undefined) {
        const cur = await c.req('GET', `/v1/products/${skuPath(sku)}/stock`) as { qty?: number } | null;
        const have = cur && cur.qty != null ? Number(cur.qty) : null;
        if (isStale(have, si.beforeRaw)) failed.push({ id: si.id, error: `${si.fieldLabel}: ${STALE}` });
        else undo.push(await writeStock(c, sku, (si.afterRaw as { quantity: number }).quantity));
      } else undo.push(await writeStock(c, sku, (si.afterRaw as { quantity: number }).quantity));
    } catch (e) {
      const prev = (e as { undo?: UndoOp[] }).undo;
      const okIds = live.filter(i => i.field !== 'stock' && !failed.some(f => f.id === i.id)).map(i => i.id);
      throw Object.assign(e instanceof Error ? e : new Error(String(e)), { undo: !prev?.length || prev === undo ? undo : [...undo, ...prev], okIds, ...(failed.length ? { failed } : {}) });
    }
  }
  return { undo, ...(failed.length ? { failed } : {}) };
}

/** Groups the rows per record. Stale fields only affect their own row; the rest is written. */
export async function applyGrouped(cs: ChangeSet, selected: Set<string>, fn: (id: string, its: ChangeItem[]) => Promise<UndoOp[] | ApplyPiece>, ctx?: ApplyCtx): Promise<ApplyResult> {
  const groups = new Map<string, ChangeItem[]>();
  let n = 0;
  for (const it of cs.items) if (selected.has(it.id) && it.entity !== 'info') { groups.set(it.entityId ?? '', [...(groups.get(it.entityId ?? '') ?? []), it]); n++; }
  const results: ApplyResult['results'] = [], undo: UndoOp[] = [], tick = partialTicker(ctx, n, { results, undo });
  const mark = (its: ChangeItem[], failed: { id: string; error: string }[] | undefined, okIds: string[] | undefined, msg: string) => {
    const bad = new Map((failed ?? []).map(f => [f.id, f.error]));
    its.forEach(i => {
      if (okIds?.includes(i.id)) results.push({ itemId: i.id, ok: true });
      else if (bad.has(i.id)) results.push({ itemId: i.id, ok: false, error: bad.get(i.id) });
      else results.push({ itemId: i.id, ok: !msg, ...(msg ? { error: msg } : {}) });
    });
  };
  await pool([...groups], WRITE_CONCURRENCY, async ([id, its]) => {
    try {
      const out = await fn(id, its);
      if (Array.isArray(out)) { undo.push(...out); its.forEach(i => results.push({ itemId: i.id, ok: true })); }
      else { undo.push(...out.undo); mark(its, out.failed, undefined, ''); }
    } catch (e) {
      const extra = (e as { undo?: UndoOp[] }).undo ?? [], okIds = (e as { okIds?: string[] }).okIds, msg = errMsg(e);
      undo.push(...extra);
      mark(its, (e as { failed?: { id: string; error: string }[] }).failed, okIds, msg);
    }
    finally { tick(); }
  });
  return { results, undo };
}

reg.register('products', (c, cs, payload, selected, ctx) => {
  const p = payload as CatalogPayload;
  return applyGrouped(cs, selected, (id, its) => { const sku = p.skus?.[id]; if (!sku) throw new Error('SKU fehlt'); return applyProduct(c, p.store, sku, its); }, ctx);
});

// ================= Categories =================
export async function buildCategoryChangeSet(ro: OmReader, { title, reason, changes }: ProposeArgs): Promise<{ cs: ChangeSet; payload: CatalogPayload }> {
  if (!changes?.length) throw new Error('changes ist leer');
  if (changes.length > MAX_ITEMS) throw new Error(`Maximal ${MAX_ITEMS} Kategorien pro Änderungsset, bitte aufteilen.`);
  const items: ChangeItem[] = [], skipped: { id: string; reason: string }[] = [], view = await ro.storeView().catch(() => undefined); let unchanged = 0;
  for (const ch of changes) {
    const id = String(ch.id), cat = await ro.category(id);
    if (!cat) { skipped.push({ id, reason: 'nicht gefunden' }); continue; }
    if (Number(cat.level) < 2) { skipped.push({ id, reason: 'Wurzelkategorie wird nicht geändert' }); continue; }
    for (const [field, raw] of Object.entries(ch.fields ?? {})) {
      const def = OM_CATEGORY_FIELDS[field];
      if (!def) { skipped.push({ id, reason: `Feld "${field}" nicht erlaubt` }); continue; }
      try {
        const v = normTitle(def, validate(def, raw), view), cur = def.kind === 'bool' ? catActive(cat) : omAttr(cat, def.attr!);
        if (def.kind === 'bool' ? cur === v : same(cur, v)) { unchanged++; continue; }
        items.push({ id: `${id}:${field}`, entity: 'category', entityId: id, label: String(cat.name ?? id), field, fieldLabel: def.label, before: shown(def, cur), after: shown(def, v), afterRaw: def.kind === 'bool' ? (v ? 1 : 0) : v, beforeRaw: def.kind === 'bool' ? (cur ? 1 : 0) : (cur ?? null), warn: field === 'active' && v === false ? ['Wird deaktiviert'] : [], ...(def.kind === 'html' ? { html: { before: String(cur ?? '').slice(0, 4000), after: String(v).slice(0, 4000) } } : {}) });
      } catch (e) { skipped.push({ id, reason: `${field}: ${errMsg(e)}` }); }
    }
  }
  if (!items.length) throw new Error(`Keine Änderung nötig bzw. nichts anwendbar (${unchanged} unverändert, ${skipped.length} übersprungen: ${skipped.slice(0, 3).map(s => s.reason).join('; ')})`);
  return { cs: { id: newIdSafe(), kind: 'categories', entity: 'category', title, reason, items, skipped, unchanged, atomic: false }, payload: { store: await ro.store() } };
}
reg.register('categories', (c, cs, payload, selected, ctx) => applyGrouped(cs, selected, async (id, its) => {
  const store = (payload as CatalogPayload).store;
  const fresh = await getCategory(c, id, store);
  if (!fresh) throw new Error('Kategorie nicht mehr vorhanden');
  const { live, failed } = splitStale(its, it => {
    const def = OM_CATEGORY_FIELDS[it.field!];
    if (!def?.attr) return undefined;
    return def.kind === 'bool' ? (catActive(fresh) ? 1 : 0) : omAttr(fresh, def.attr);
  });
  if (!live.length) return { undo: [], failed };
  const scoped: Record<string, unknown> = {};
  for (const it of live) scoped[OM_CATEGORY_FIELDS[it.field!].attr!] = it.afterRaw;
  try { return { undo: await writeScoped(c, 'category', id, store, scoped), ...(failed.length ? { failed } : {}) }; }
  catch (e) { return withFailed(e, [], failed); }
}, ctx));

// ================= Translations (store views) =================
const TR_FIELDS: Record<'product' | 'category', Record<string, FieldDef>> = {
  product: { name: OM_PRODUCT_FIELDS.name, description: OM_PRODUCT_FIELDS.description, shortDescription: OM_PRODUCT_FIELDS.shortDescription, metaTitle: OM_PRODUCT_FIELDS.metaTitle, metaDescription: OM_PRODUCT_FIELDS.metaDescription, keywords: OM_PRODUCT_FIELDS.keywords },
  category: { name: OM_CATEGORY_FIELDS.name, description: OM_CATEGORY_FIELDS.description, metaTitle: OM_CATEGORY_FIELDS.metaTitle, metaDescription: OM_CATEGORY_FIELDS.metaDescription, keywords: OM_CATEGORY_FIELDS.keywords },
};
export const TRANSLATION_FIELDS = TR_FIELDS;
export interface TranslationArgs { title: string; reason: string; entity: 'product' | 'category'; changes: { id: string; store: string; fields: Record<string, unknown> }[] }
export interface TranslationPayload { refs: Record<string, string> }

/** Store views with locale */
export async function storeViewList(ro: OmReader) {
  const main = await ro.store();
  return (await ro.storeViews()).map(v => ({ id: v.id, code: v.code, name: v.name, active: !!v.is_active, websiteId: v.website_id, locale: v.locale ?? null, currency: v.currency ?? null, isDefault: v.code === main, ...(v.title_suffix?.trim() ? { titleSuffix: v.title_suffix.trim(), hint: 'Das Theme hängt dieses Suffix an jeden Seitentitel an; Meta-Titles und Seitentitel ohne Shopnamen schreiben.' } : {}) }));
}

export async function buildTranslationChangeSet(ro: OmReader, a: TranslationArgs): Promise<{ cs: ChangeSet; payload: TranslationPayload }> {
  if (!a.changes?.length) throw new Error('changes ist leer');
  const views = await storeViewList(ro), FIELDS = TR_FIELDS[a.entity];
  if (!FIELDS) throw new Error('entity: product oder category');
  const items: ChangeItem[] = [], skipped: { id: string; reason: string }[] = [], refs: Record<string, string> = {}; let unchanged = 0;
  for (const ch of a.changes) {
    const sv = await ro.storeView(String(ch.store)), view = sv && views.find(v => v.code === sv.code); // code, ID or locale (one resolution for all tools)
    if (!view) { skipped.push({ id: String(ch.id), reason: `Store-View „${ch.store}“ gibt es nicht (vorhanden: ${views.map(v => `${v.code} (${v.locale})`).join(', ')})` }); continue; }
    const base = a.entity === 'product' ? await ro.productByRef(String(ch.id), 'admin') : await ro.category(ch.id, 'admin');
    if (!base) { skipped.push({ id: String(ch.id), reason: 'nicht gefunden' }); continue; }
    const ref = a.entity === 'product' ? String(base.sku) : String(base.id), id = String(base.id);
    const inView = a.entity === 'product' ? await ro.product(ref, view.code) : await ro.category(ref, view.code);
    if (!inView) { skipped.push({ id, reason: 'nicht lesbar' }); continue; }
    refs[id] = ref;
    const label = `${a.entity === 'product' ? productLabel(base) : base.name} · ${view.name}${view.locale ? ` (${view.locale})` : ''}`;
    for (const [field, raw] of Object.entries(ch.fields ?? {})) {
      const def = FIELDS[field];
      if (!def) { skipped.push({ id, reason: `Feld "${field}" nicht übersetzbar` }); continue; }
      try {
        const cur = omAttr(inView, def.attr!), g = omAttr(base, def.attr!), own = Array.isArray(inView.store_overrides) && inView.store_overrides.includes(def.attr!);
        if (raw === null) {
          if (!own) { unchanged++; continue; }
          items.push({ id: `${id}:${view.code}:${field}`, entity: a.entity, entityId: id, label, field, fieldLabel: def.label, before: cut(cur), after: `erbt wieder: ${cut(g, 120)}`, afterRaw: { store: view.code, attr: def.attr, value: null }, warn: [] });
          continue;
        }
        const v = normTitle(def, validate(def, raw), await ro.storeView(view.code));
        if (own && same(cur, v)) { unchanged++; continue; }
        const warn: string[] = [];
        if (same(v, g)) warn.push('Gleicher Text wie die Standardebene (wird trotzdem als eigener Wert der Store-View gespeichert)');
        items.push({ id: `${id}:${view.code}:${field}`, entity: a.entity, entityId: id, label, field, fieldLabel: def.label, before: own ? cut(cur) : `– (erbt: ${cut(g, 120)})`, after: cut(v), afterRaw: { store: view.code, attr: def.attr, value: v }, warn, ...(def.kind === 'html' ? { html: { before: String(cur ?? '').slice(0, 4000), after: String(v).slice(0, 4000) } } : {}) });
      } catch (e) { skipped.push({ id, reason: `${field}: ${errMsg(e)}` }); }
    }
  }
  if (items.length > MAX_ITEMS) throw new Error(`${items.length} Einträge, maximal ${MAX_ITEMS} pro Änderungsset, bitte aufteilen.`);
  if (!items.length) throw new Error(`Keine Änderung nötig bzw. nichts anwendbar (${unchanged} unverändert, ${skipped.length} übersprungen: ${skipped.slice(0, 3).map(s => s.reason).join('; ')})`);
  return { cs: { id: newIdSafe(), kind: 'translations', entity: a.entity, noun: { one: 'Übersetzung', many: 'Übersetzungen' }, title: a.title, reason: a.reason, items, skipped, unchanged, atomic: false }, payload: { refs } };
}
reg.register('translations', (c, cs, payload, selected, ctx) => {
  const refs = (payload as TranslationPayload).refs, e = cs.entity as 'product' | 'category';
  const groups = new Map<string, ChangeItem[]>();
  let n = 0;
  for (const it of cs.items) if (selected.has(it.id) && it.entity !== 'info') { const k = `${it.entityId}|${(it.afterRaw as { store: string }).store}`; groups.set(k, [...(groups.get(k) ?? []), it]); n++; }
  const results: ApplyResult['results'] = [], undo: UndoOp[] = [], tick = partialTicker(ctx, n, { results, undo });
  return pool([...groups], WRITE_CONCURRENCY, async ([k, its]) => {
    const [id, store] = k.split('|');
    try {
      const values = Object.fromEntries(its.map(i => { const r = i.afterRaw as { attr: string; value: unknown }; return [r.attr, r.value]; }));
      undo.push(...await writeStore(c, e, refs[id], store, values)); its.forEach(i => results.push({ itemId: i.id, ok: true }));
    } catch (err) { its.forEach(i => results.push({ itemId: i.id, ok: false, error: errMsg(err) })); }
    finally { tick(); }
  }).then(() => ({ results, undo }));
});

// ================= URL keys (SEO URLs) with redirect =================
export interface SeoUrlArgs { title: string; reason: string; entity: 'product' | 'category'; changes: { id: string; urlKey: string }[] }
export async function buildSeoUrlChangeSet(ro: OmReader, a: SeoUrlArgs): Promise<{ cs: ChangeSet; payload: CatalogPayload }> {
  if (!a.changes?.length) throw new Error('changes ist leer');
  if (a.changes.length > MAX_ITEMS) throw new Error(`Maximal ${MAX_ITEMS} pro Änderungsset.`);
  const sf = await ro.suffixes(), suffix = a.entity === 'product' ? sf.product : sf.category, info = await ro.info();
  const items: ChangeItem[] = [], skipped: { id: string; reason: string }[] = [], skus: Record<string, string> = {}, seen = new Set<string>(); let unchanged = 0;
  const cats = a.entity === 'category' ? await ro.categoriesFlat('admin').catch(() => [] as OmCategory[]) : [];
  for (const ch of a.changes) {
    const rec = a.entity === 'product' ? await ro.productByRef(String(ch.id)) : await ro.category(ch.id);
    if (!rec) { skipped.push({ id: String(ch.id), reason: 'nicht gefunden' }); continue; }
    const id = String(rec.id), key = urlKey(String(ch.urlKey ?? '').replace(/\.html?$/i, '').split('/').pop() ?? '');
    if (a.entity === 'product') skus[id] = rec.sku;
    if (!key) { skipped.push({ id, reason: 'URL-Schlüssel leer' }); continue; }
    const cur = omStr(rec, 'url_key');
    if (cur === key) { unchanged++; continue; }
    if (seen.has(key)) { skipped.push({ id, reason: `„${key}“ doppelt im Set` }); continue; }
    // taken? Products: rewrite to the path in the main store view; categories: siblings with the same key
    const clash = a.entity === 'product' ? await ro.resolveUrl(`${key}${suffix}`).then(r => (r && r.type === 'PRODUCT' && String(r.id) !== id ? `Produkt ${r.id}` : r && r.type === 'CATEGORY' ? `Kategorie ${r.id}` : null)).catch(() => null)
      : cats.filter(x => String(x.id) !== id && Number(x.parent_id) === Number(rec.parent_id) && x.url_key === key).map(x => x.name ?? x.id)[0] ?? null;
    if (clash) { skipped.push({ id, reason: `URL-Schlüssel „${key}“ ist schon vergeben (${clash})` }); continue; }
    seen.add(key);
    const path = a.entity === 'category' ? String(omStr(rec, 'url_path') ?? cur ?? '').replace(/\.html?$/i, '').split('/').slice(0, -1).concat(key).join('/') : key;
    items.push({ id: `${id}:urlKey`, entity: a.entity, entityId: id, label: a.entity === 'product' ? productLabel(rec) : String(rec.name), field: 'urlKey', fieldLabel: 'URL-Schlüssel', before: `${cur ?? '–'}${cur ? suffix : ''}`, after: `${path}${suffix}`, afterRaw: key,
      warn: [info.save_rewrites_history ? `Alte URL leitet per 301 auf die neue weiter${a.entity === 'category' ? ' (auch für Unterkategorien und Produkt-URLs mit Kategoriepfad)' : ''}` : '„Save Rewrites History“ ist im Shop aus: die alte URL leitet NICHT weiter'] });
  }
  if (!items.length) throw new Error(`Keine Änderung nötig bzw. nichts anwendbar (${unchanged} unverändert, ${skipped.length} übersprungen: ${skipped.slice(0, 3).map(s => s.reason).join('; ')})`);
  items.push({ id: 'info:undo', entity: 'info', label: 'Rückgängig', fieldLabel: '', before: '', after: 'Rückgängig stellt den alten URL-Schlüssel wieder her und löscht die dabei angelegte Weiterleitung.', warn: [] });
  return { cs: { id: newIdSafe(), kind: 'seo-urls', entity: a.entity, noun: { one: 'URL', many: 'URLs' }, title: a.title, reason: a.reason, items, skipped, unchanged, atomic: false }, payload: { store: await ro.store(), skus } };
}
reg.register('seo-urls', (c, cs, payload, selected, ctx) => {
  const p = payload as CatalogPayload, e = cs.entity as 'product' | 'category';
  return applyEach(cs, selected, it => writeScoped(c, e, e === 'product' ? p.skus![it.entityId!] : it.entityId!, p.store, { url_key: it.afterRaw }), ctx);
});

// ================= Category assignment of products =================
export interface CategoryProductsArgs { title: string; reason: string; categoryId: string; add?: { productId: string; position?: number }[]; remove?: string[] }
export async function buildCategoryProductsChangeSet(ro: OmReader, a: CategoryProductsArgs): Promise<{ cs: ChangeSet; payload: { categoryId: string } }> {
  const cat = await ro.category(a.categoryId);
  if (!cat) throw new Error('Kategorie nicht gefunden');
  if (Number(cat.level) < 2) throw new Error('Der Wurzelkategorie werden keine Produkte zugeordnet');
  const refs = [...(a.add ?? []).map(x => String(x.productId)), ...(a.remove ?? []).map(String)];
  if (refs.length > MAX_ITEMS) throw new Error(`Maximal ${MAX_ITEMS} Produkte pro Änderungsset.`);
  const byRef = await loadProducts(ro, refs);
  const items: ChangeItem[] = [], skipped: { id: string; reason: string }[] = [];
  const linked = (p: OmProduct) => (p.category_ids ?? []).map(Number).includes(Number(cat.id));
  for (const x of a.add ?? []) {
    const p = byRef.get(String(x.productId)); if (!p) { skipped.push({ id: String(x.productId), reason: 'nicht gefunden' }); continue; }
    if (linked(p)) { skipped.push({ id: String(p.id), reason: 'schon zugeordnet' }); continue; }
    items.push({ id: `add:${p.id}`, entity: 'product', entityId: String(p.id), label: productLabel(p), field: 'category', fieldLabel: `Kategorie „${cat.name}“`, before: 'nicht zugeordnet', after: 'zugeordnet', afterRaw: { sku: p.sku, position: x.position ?? 0, add: true }, warn: Number(p.visibility) === 1 ? ['Einzeln nicht sichtbar (Sichtbarkeit „nicht einzeln sichtbar“)'] : [] });
  }
  for (const r of a.remove ?? []) {
    const p = byRef.get(String(r)); if (!p) { skipped.push({ id: String(r), reason: 'nicht gefunden' }); continue; }
    if (!linked(p)) { skipped.push({ id: String(p.id), reason: 'nicht zugeordnet' }); continue; }
    items.push({ id: `rm:${p.id}`, entity: 'product', entityId: String(p.id), label: productLabel(p), field: 'category', fieldLabel: `Kategorie „${cat.name}“`, before: 'zugeordnet', after: 'entfernt', afterRaw: { sku: p.sku, add: false }, warn: ['Die Produkt-URL mit Kategoriepfad dieser Kategorie entfällt'] });
  }
  if (!items.length) throw new Error(`Nichts zu ändern (${skipped.map(s => s.reason).slice(0, 3).join('; ') || 'leer'})`);
  return { cs: { id: newIdSafe(), kind: 'category-products', entity: 'category', noun: { one: 'Zuordnung', many: 'Zuordnungen' }, title: a.title, reason: a.reason, items, skipped, atomic: false }, payload: { categoryId: String(cat.id) } };
}
reg.register('category-products', async (c, cs, payload, selected, ctx) => {
  const cid = Number((payload as { categoryId: string }).categoryId);
  const results: ApplyResult['results'] = [], undo: UndoOp[] = [], list = cs.items.filter(i => selected.has(i.id) && i.entity !== 'info'), tick = partialTicker(ctx, list.length, { results, undo });
  for (const it of list) { // sequentially (the category model saves the assignment every time)
    try { undo.push(await linkOne(it)); results.push({ itemId: it.id, ok: true }); } catch (e) { results.push({ itemId: it.id, ok: false, error: errMsg(e) }); } finally { tick(); }
  }
  return { results, undo };
  async function linkOne(it: ChangeItem): Promise<UndoOp> {
    const { sku, position, add } = it.afterRaw as { sku: string; position?: number; add: boolean }, path = `/v1/products/${skuPath(sku)}/categories`;
    if (add) { await c.req('PUT', path, { add: [{ id: cid, position: position ?? 0 }] }); return reqOp('category-product', sku, 'PUT', path, { remove: [cid] }); }
    const cur = ((await c.req('GET', path)) as { id: number; position: number }[]).find(l => Number(l.id) === cid);
    await c.req('PUT', path, { remove: [cid] });
    return reqOp('category-product', sku, 'PUT', path, { add: [{ id: cid, position: cur?.position ?? 0 }] });
  }
});

/** Output helpers for tools */
export const priceView = (p: OmRecord) => { const s = priceOf(p); return { price: money(s.selling), priceValue: s.selling, listPrice: s.list, regularPrice: s.regular, specialPrice: s.special, specialFrom: s.from, specialTo: s.to, specialActive: s.active }; };

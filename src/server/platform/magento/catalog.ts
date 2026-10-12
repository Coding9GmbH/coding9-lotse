import 'server-only';
// Magento: Änderungssets für Produkte, Kategorien, Übersetzungen, URL-Schlüssel und Kategorie-Zuordnungen (bauen + Executor).
// Bauen liest über den geschützten Lese-Client; der Executor liest die Vorher-Werte neu und schreibt mit dem privilegierten Client.
import type { ChangeItem, ChangeSet, UndoOp } from '@/lib/protocol';
import { applyEach, errMsg, MAX_ITEMS, newIdSafe, partialTicker, pool, resolvePrice, WRITE_CONCURRENCY, type ApplyCtx, type ApplyResult, type PriceSpec } from './kit';
import { skuPath, type MagentoClient } from './client';
import { attr, attrStr, basisWord, day, isActive, money, needBasis, plain, planPrice, priceState, priceText, priceUndo, sameValue, urlKey, VISIBILITY, VISIBILITY_IN, type MProduct, type MRecord, type PriceWrite } from './map';
import type { MagentoReader } from './reader';
import { getEnt, reg, reqOp, writeScoped, writeStore } from './write';

type Kind = 'str' | 'html' | 'price' | 'date' | 'int' | 'bool' | 'visibility' | 'num';
interface FieldDef { label: string; kind: Kind; attr?: string }
/** Felder für propose_product_changes (Namen wie bei Shopware, wo sie passen) → Magento-Attribut */
export const M_PRODUCT_FIELDS: Record<string, FieldDef> = {
  name: { label: 'Name', kind: 'str', attr: 'name' }, description: { label: 'Beschreibung', kind: 'html', attr: 'description' }, shortDescription: { label: 'Kurzbeschreibung', kind: 'html', attr: 'short_description' },
  metaTitle: { label: 'Meta-Title', kind: 'str', attr: 'meta_title' }, metaDescription: { label: 'Meta-Description', kind: 'str', attr: 'meta_description' }, keywords: { label: 'Meta-Keywords', kind: 'str', attr: 'meta_keyword' },
  price: { label: 'Preis', kind: 'price' }, listPrice: { label: 'Streichpreis', kind: 'price' }, specialFromDate: { label: 'Sonderpreis ab', kind: 'date' }, specialToDate: { label: 'Sonderpreis bis', kind: 'date' },
  stock: { label: 'Bestand', kind: 'int' }, active: { label: 'Aktiv', kind: 'bool', attr: 'status' }, visibility: { label: 'Sichtbarkeit', kind: 'visibility', attr: 'visibility' }, weight: { label: 'Gewicht', kind: 'num', attr: 'weight' },
};
export const M_CATEGORY_FIELDS: Record<string, FieldDef> = {
  name: { label: 'Name', kind: 'str', attr: 'name' }, description: { label: 'Beschreibung', kind: 'html', attr: 'description' },
  metaTitle: { label: 'Meta-Title', kind: 'str', attr: 'meta_title' }, metaDescription: { label: 'Meta-Description', kind: 'str', attr: 'meta_description' }, keywords: { label: 'Meta-Keywords', kind: 'str', attr: 'meta_keywords' },
  active: { label: 'Aktiv', kind: 'bool', attr: 'is_active' },
};
/** Eigene Produktattribute (propose_product_changes fields.attributes): erlaubte Eingabetypen */
const ATTR_INPUTS = new Set(['text', 'textarea', 'select', 'boolean']);
const PRICE_KEYS = ['price', 'listPrice', 'specialFromDate', 'specialToDate'];
const cut = (t: unknown, n = 220) => { const s = plain(t); return s.length > n ? `${s.slice(0, n)}…` : s || '–'; };
export const productLabel = (p: MRecord) => `${p.name ?? p.sku} (${p.sku})`;
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
const shown = (def: FieldDef, v: unknown) => (def.kind === 'bool' ? (v ? 'ja' : 'nein') : def.kind === 'visibility' ? VISIBILITY[Number(v)] ?? String(v ?? '–') : def.kind === 'int' || def.kind === 'num' ? String(v ?? '–') : cut(v));

export interface ProposeArgs { title: string; reason: string; changes: { id: string; fields: Record<string, unknown> }[] }
/** Payload der Sets products/categories: Store-View beim Bauen + SKU je Produkt-ID (Magento schreibt per SKU) */
export interface CatalogPayload { store: string; skus?: Record<string, string> }

/** Bestand (MSI): nur mit genau einer aktiven Quelle sicher änderbar */
export async function stockSource(ro: MagentoReader): Promise<{ source: string } | { reason: string }> {
  const src = await ro.sources().catch(() => null);
  if (!src) return { reason: 'Bestand ist ohne Magento Inventory (MSI) über Lotse nicht änderbar' };
  const on = src.filter(s => s.enabled !== false);
  return on.length === 1 ? { source: String(on[0].source_code) } : { reason: `${on.length} Lagerquellen (MSI): Bestand bitte je Quelle in Magento pflegen` };
}

// ================= Produkte =================
export async function buildProductChangeSet(ro: MagentoReader, { title, reason, changes }: ProposeArgs): Promise<{ cs: ChangeSet; payload: CatalogPayload }> {
  if (!changes?.length) throw new Error('changes ist leer');
  if (changes.length > MAX_ITEMS) throw new Error(`Maximal ${MAX_ITEMS} Produkte pro Änderungsset, bitte aufteilen.`);
  const refs = [...new Set(changes.map(c => String(c.id)))];
  const byId = new Map<string, MProduct>();
  for (const p of await ro.productsByIds(refs)) byId.set(String(p.id), p);
  for (const p of await ro.productsBySkus(refs.filter(r => !byId.has(r)))) byId.set(p.sku, p);
  const items: ChangeItem[] = [], skipped: { id: string; reason: string }[] = [], skus: Record<string, string> = {};
  let unchanged = 0;
  const needStock = changes.some(c => c.fields && 'stock' in c.fields);
  const stock = needStock ? await stockSource(ro) : null;
  const srcItems = needStock && stock && 'source' in stock ? await ro.sourceItems([...byId.values()].map(p => p.sku)) : [];
  const attrDefs = new Map<string, MRecord | null>();
  for (const ch of changes) {
    const p = byId.get(String(ch.id));
    if (!p) { skipped.push({ id: String(ch.id), reason: 'nicht gefunden' }); continue; }
    const id = String(p.id), label = productLabel(p); skus[id] = p.sku;
    const f = { ...(ch.fields ?? {}) }, push = (field: string, fieldLabel: string, before: string, after: string, afterRaw: unknown, warn: string[] = [], html?: ChangeItem['html']) => items.push({ id: `${id}:${field}`, entity: 'product', entityId: id, label, field, fieldLabel, before, after, afterRaw, warn, ...(html ? { html } : {}) });
    // Preise: price/listPrice/Sonderpreis-Zeitraum ergeben EINE Zeile mit den Magento-Werten
    if (PRICE_KEYS.some(k => k in f)) {
      try {
        if (p.type_id === 'configurable' || p.type_id === 'bundle' || p.type_id === 'grouped') throw new Error(`Preis eines ${p.type_id}-Produkts kommt aus seinen Einzelprodukten, dort ändern`);
        const basis = needBasis(ro.priceBasis), s = priceState(p);
        const want: { price?: number; listPrice?: number | null; from?: string | null; to?: string | null } = {};
        if ('price' in f) { const v = resolvePrice(s.selling, f.price as PriceSpec); if (v == null) throw new Error('Preis kann nicht entfernt werden'); want.price = v; }
        if ('listPrice' in f) want.listPrice = resolvePrice(s.list, f.listPrice as PriceSpec);
        if ('specialFromDate' in f) want.from = validate(M_PRODUCT_FIELDS.specialFromDate, f.specialFromDate) as string | null;
        if ('specialToDate' in f) want.to = validate(M_PRODUCT_FIELDS.specialToDate, f.specialToDate) as string | null;
        if ((want.price != null && !(want.price >= 0)) || (want.listPrice != null && !(want.listPrice >= 0))) throw new Error('Preis: ungültiger Wert');
        const { write, notes } = planPrice(s, want);
        if (!Object.keys(write).length) unchanged++;
        else {
          const next = { selling: want.price ?? s.selling, list: want.listPrice === undefined ? s.list : want.listPrice };
          const warn = [...notes];
          if (next.selling === 0) warn.push('Preis 0 €');
          if (s.selling && next.selling != null) { const d = ((next.selling - s.selling) / s.selling) * 100; if (Math.abs(d) >= 30) warn.push(`Preisänderung ${d > 0 ? '+' : ''}${d.toFixed(0)} %`); }
          const period = write.special_to_date || write.special_from_date ? ` · Zeitraum ${write.special_from_date ?? s.from ?? '…'} bis ${write.special_to_date ?? s.to ?? '…'}` : '';
          push('price', `Preis ${basisWord(basis)} (Streichpreis)`, priceText(s, basis), `${priceText(next, basis)}${period}`, { write, expect: priceUndo(p, Object.keys(write) as (keyof PriceWrite)[]) }, warn);
        }
      } catch (e) { skipped.push({ id, reason: `Preis: ${errMsg(e)}` }); }
      for (const k of PRICE_KEYS) delete f[k];
    }
    if (f.attributes && typeof f.attributes === 'object') {
      for (const [code, raw] of Object.entries(f.attributes as Record<string, unknown>)) {
        try {
          if (!attrDefs.has(code)) attrDefs.set(code, /^[a-z][a-z0-9_]{0,59}$/.test(code) ? await ro.attribute(code) : null);
          const def = attrDefs.get(code);
          if (!def || !def.is_user_defined || !ATTR_INPUTS.has(def.frontend_input)) throw new Error('Attribut nicht vorhanden oder nicht über Lotse änderbar');
          const opts = (def.options ?? []) as { label: string; value: string }[], curRaw = attr(p, code);
          let v: unknown = raw, shownAfter = String(raw);
          if (def.frontend_input === 'select') { const o = opts.find(x => x.value !== '' && (x.label.toLowerCase() === String(raw).trim().toLowerCase() || x.value === String(raw))); if (!o) throw new Error(`Wert „${raw}“ gibt es nicht (vorhanden: ${opts.filter(x => x.value !== '').map(x => x.label).slice(0, 15).join(', ')})`); v = o.value; shownAfter = o.label; }
          else if (def.frontend_input === 'boolean') { if (typeof raw !== 'boolean') throw new Error('true/false erwartet'); v = raw ? '1' : '0'; shownAfter = raw ? 'ja' : 'nein'; }
          else if (typeof raw !== 'string') throw new Error('Text erwartet');
          if (sameValue(curRaw, v)) { unchanged++; continue; }
          const before = def.frontend_input === 'select' ? opts.find(x => x.value === String(curRaw))?.label ?? '–' : def.frontend_input === 'boolean' ? (curRaw == null ? '–' : String(curRaw) === '1' ? 'ja' : 'nein') : cut(curRaw);
          push(`attr:${code}`, def.default_frontend_label ?? code, before, cut(shownAfter), { attr: code, value: v, scope: def.scope ?? 'store' });
        } catch (e) { skipped.push({ id, reason: `${code}: ${errMsg(e)}` }); }
      }
      delete f.attributes;
    }
    for (const [field, raw] of Object.entries(f)) {
      const def = M_PRODUCT_FIELDS[field];
      if (!def) { skipped.push({ id, reason: `Feld "${field}" nicht erlaubt` }); continue; }
      try {
        let v = validate(def, raw);
        if (field === 'stock') {
          if (!stock || 'reason' in stock) throw new Error(stock && 'reason' in stock ? stock.reason : 'Bestand nicht lesbar');
          if (p.type_id !== 'simple' && p.type_id !== 'virtual') throw new Error(`${p.type_id}-Produkte haben keinen eigenen Bestand`);
          const si = srcItems.find(s => s.sku === p.sku && s.source_code === stock.source);
          const cur = si ? Number(si.quantity) : null;
          if (cur === v) { unchanged++; continue; }
          push('stock', def.label, cur == null ? '–' : String(cur), String(v), { source: stock.source, quantity: v }, cur != null && cur > 0 && v === 0 ? ['Bestand auf 0'] : []);
          continue;
        }
        if (field === 'active') v = v ? 1 : 2;
        const cur = attr(p, def.attr!);
        if (sameValue(cur, v)) { unchanged++; continue; }
        const warn: string[] = [];
        if (field === 'active' && v === 2) warn.push('Wird deaktiviert');
        if (field === 'visibility' && v === 1) warn.push('Nicht mehr einzeln im Shop sichtbar');
        const before = field === 'active' ? (isActive(p) ? 'ja' : 'nein') : shown(def, cur), after = field === 'active' ? (v === 1 ? 'ja' : 'nein') : shown(def, v);
        push(field, def.label, before, after, v, warn, def.kind === 'html' ? { before: String(cur ?? '').slice(0, 4000), after: String(v).slice(0, 4000) } : undefined);
      } catch (e) { skipped.push({ id, reason: `${field}: ${errMsg(e)}` }); }
    }
  }
  if (!items.length) throw new Error(`Keine Änderung nötig bzw. nichts anwendbar (${unchanged} unverändert, ${skipped.length} übersprungen: ${skipped.slice(0, 3).map(s => s.reason).join('; ')})`);
  if (items.some(i => i.field === 'price')) items.push({ id: 'info:preis', entity: 'info', label: 'Hinweis Magento-Preise', fieldLabel: '', before: '', after: `Magento zeigt den regulären Preis durchgestrichen, solange ein niedrigerer Sonderpreis gilt. Lotse setzt dafür price (Streichpreis) und special_price (Verkaufspreis). Alle Preise ${basisWord(ro.priceBasis)}, wie im Magento-Admin eingegeben${ro.priceBasis === 'net' ? '; der Kunde zahlt zusätzlich die MwSt.' : ''}.`, warn: [] });
  return { cs: { id: newIdSafe(), kind: 'products', entity: 'product', title, reason, items, skipped, unchanged, atomic: false }, payload: { store: ro.storeCode, skus } };
}

/**
 * Preisprüfung vor dem Schreiben im Scope des Vorschlags (Store-View der Einstellungen, in der der Vorschlag gerechnet wurde):
 * bei Preis-Scope „Website“ löst ein Website-Preis so keine falsche Meldung „inzwischen geändert“ aus.
 */
export async function assertPriceUnchanged(c: MagentoClient, sku: string, store: string, expect: PriceWrite): Promise<void> {
  const cur = await getEnt(c, 'product', sku, store);
  if (!cur) throw new Error('Produkt nicht mehr vorhanden');
  const now = priceUndo(cur, Object.keys(expect) as (keyof PriceWrite)[]) as Record<string, unknown>, exp = expect as Record<string, unknown>;
  if (Object.keys(exp).some(k => !sameValue(day(now[k]), day(exp[k])))) throw new Error('Preis wurde inzwischen in Magento geändert, bitte neu vorschlagen');
}
/**
 * Nach dem globalen Schreiben der Preisfelder: zeigt die Store-View den neuen Wert? Ein Website-Preis (Preis-Scope „Website“)
 * verdeckt den globalen Wert; dann Fehler statt Erfolg, die Rückgängig-Schritte des Schreibvorgangs hängen am Fehler.
 * Datumsfelder werden nicht verglichen (special_from_date setzt Magento beim Speichern selbst).
 */
export async function assertPriceInView(c: MagentoClient, sku: string, store: string, write: PriceWrite, undo: UndoOp[]): Promise<void> {
  const keys = (['price', 'special_price'] as const).filter(k => k in write);
  if (store === 'all' || !keys.length) return;
  const now = priceUndo((await getEnt(c, 'product', sku, store)) ?? {}, keys) as Record<string, unknown>;
  if (keys.some(k => !sameValue(now[k], write[k]))) throw Object.assign(new Error(`Die Store-View „${store}“ zeigt weiter ihren Website-Preis (Preis-Scope „Website“): Preis bitte in Magento je Website pflegen`), { undo });
}

async function applyProduct(c: MagentoClient, store: string, sku: string, its: ChangeItem[]): Promise<UndoOp[]> {
  const scoped: Record<string, unknown> = {}, global: Record<string, unknown> = {}, undo: UndoOp[] = [];
  for (const it of its) {
    const def = it.field ? M_PRODUCT_FIELDS[it.field] : undefined;
    if (it.field?.startsWith('attr:')) { const a = it.afterRaw as { attr: string; value: unknown; scope: string }; (a.scope === 'global' ? global : scoped)[a.attr] = a.value; }
    else if (def?.attr && it.field !== 'stock') (def.attr === 'weight' ? global : scoped)[def.attr] = it.afterRaw;
  }
  const pi = its.find(i => i.field === 'price'), pw = pi ? (pi.afterRaw as { write: PriceWrite; expect: PriceWrite }) : null;
  if (pw) { await assertPriceUnchanged(c, sku, store, pw.expect); Object.assign(global, pw.write); }
  if (Object.keys(scoped).length || Object.keys(global).length) undo.push(...await writeScoped(c, 'product', sku, store, scoped, global));
  if (pw) await assertPriceInView(c, sku, store, pw.write, undo);
  const si = its.find(i => i.field === 'stock');
  if (si) {
    const { source, quantity } = si.afterRaw as { source: string; quantity: number };
    const r = await c.search('/V1/inventory/source-items', { filters: [[{ field: 'sku', value: sku }], [{ field: 'source_code', value: source }]], pageSize: 1 }, { store: 'all' });
    const cur = r.items[0];
    await c.req('POST', '/V1/inventory/source-items', { sourceItems: [{ sku, source_code: source, quantity, status: quantity > 0 ? 1 : cur?.status ?? 0 }] }, { store: 'all' });
    undo.push(cur ? reqOp('source-item', sku, 'POST', '/all/V1/inventory/source-items', { sourceItems: [{ sku, source_code: source, quantity: cur.quantity, status: cur.status }] })
      : reqOp('source-item', sku, 'POST', '/all/V1/inventory/source-items-delete', { sourceItems: [{ sku, source_code: source }] }));
  }
  return undo;
}

/** Gruppiert die Zeilen je Datensatz (ein Schreibvorgang je Produkt/Kategorie, Fehler gelten für alle Zeilen des Datensatzes) */
async function applyGrouped(cs: ChangeSet, selected: Set<string>, fn: (id: string, its: ChangeItem[]) => Promise<UndoOp[]>, ctx?: ApplyCtx): Promise<ApplyResult> {
  const groups = new Map<string, ChangeItem[]>();
  let n = 0;
  for (const it of cs.items) if (selected.has(it.id) && it.entity !== 'info') { groups.set(it.entityId ?? '', [...(groups.get(it.entityId ?? '') ?? []), it]); n++; }
  const results: ApplyResult['results'] = [], undo: UndoOp[] = [], tick = partialTicker(ctx, n, { results, undo });
  await pool([...groups], WRITE_CONCURRENCY, async ([id, its]) => {
    try { undo.push(...await fn(id, its)); its.forEach(i => results.push({ itemId: i.id, ok: true })); }
    catch (e) { undo.push(...((e as { undo?: UndoOp[] }).undo ?? [])); its.forEach(i => results.push({ itemId: i.id, ok: false, error: errMsg(e) })); } // teilweise geschrieben: Rückgängig-Schritte behalten
    finally { tick(); }
  });
  return { results, undo };
}

reg.register('products', (c, cs, payload, selected, ctx) => {
  const p = payload as CatalogPayload;
  return applyGrouped(cs, selected, (id, its) => { const sku = p.skus?.[id]; if (!sku) throw new Error('SKU fehlt'); return applyProduct(c, p.store, sku, its); }, ctx);
});

// ================= Kategorien =================
export async function buildCategoryChangeSet(ro: MagentoReader, { title, reason, changes }: ProposeArgs): Promise<{ cs: ChangeSet; payload: CatalogPayload }> {
  if (!changes?.length) throw new Error('changes ist leer');
  if (changes.length > MAX_ITEMS) throw new Error(`Maximal ${MAX_ITEMS} Kategorien pro Änderungsset, bitte aufteilen.`);
  const items: ChangeItem[] = [], skipped: { id: string; reason: string }[] = []; let unchanged = 0;
  for (const ch of changes) {
    const id = String(ch.id), cat = await ro.category(id);
    if (!cat) { skipped.push({ id, reason: 'nicht gefunden' }); continue; }
    if (Number(cat.level) < 2) { skipped.push({ id, reason: 'Wurzelkategorie wird nicht geändert' }); continue; }
    for (const [field, raw] of Object.entries(ch.fields ?? {})) {
      const def = M_CATEGORY_FIELDS[field];
      if (!def) { skipped.push({ id, reason: `Feld "${field}" nicht erlaubt` }); continue; }
      try {
        const v = validate(def, raw), cur = attr(cat, def.attr!);
        if (sameValue(cur, v) || (def.kind === 'bool' && !!cur === v)) { unchanged++; continue; }
        items.push({ id: `${id}:${field}`, entity: 'category', entityId: id, label: String(cat.name ?? id), field, fieldLabel: def.label, before: shown(def, cur), after: shown(def, v), afterRaw: v, warn: field === 'active' && v === false ? ['Wird deaktiviert'] : [], ...(def.kind === 'html' ? { html: { before: String(cur ?? '').slice(0, 4000), after: String(v).slice(0, 4000) } } : {}) });
      } catch (e) { skipped.push({ id, reason: `${field}: ${errMsg(e)}` }); }
    }
  }
  if (!items.length) throw new Error(`Keine Änderung nötig bzw. nichts anwendbar (${unchanged} unverändert, ${skipped.length} übersprungen: ${skipped.slice(0, 3).map(s => s.reason).join('; ')})`);
  return { cs: { id: newIdSafe(), kind: 'categories', entity: 'category', title, reason, items, skipped, unchanged, atomic: false }, payload: { store: ro.storeCode } };
}
reg.register('categories', (c, cs, payload, selected, ctx) => applyGrouped(cs, selected, (id, its) => {
  const scoped: Record<string, unknown> = {};
  for (const it of its) scoped[M_CATEGORY_FIELDS[it.field!].attr!] = it.afterRaw;
  return writeScoped(c, 'category', id, (payload as CatalogPayload).store, scoped);
}, ctx));

// ================= Übersetzungen (Store-Views) =================
const TR_FIELDS: Record<'product' | 'category', Record<string, FieldDef>> = {
  product: { name: M_PRODUCT_FIELDS.name, description: M_PRODUCT_FIELDS.description, shortDescription: M_PRODUCT_FIELDS.shortDescription, metaTitle: M_PRODUCT_FIELDS.metaTitle, metaDescription: M_PRODUCT_FIELDS.metaDescription, keywords: M_PRODUCT_FIELDS.keywords },
  category: { name: M_CATEGORY_FIELDS.name, description: M_CATEGORY_FIELDS.description, metaTitle: M_CATEGORY_FIELDS.metaTitle, metaDescription: M_CATEGORY_FIELDS.metaDescription, keywords: M_CATEGORY_FIELDS.keywords },
};
export const TRANSLATION_FIELDS = TR_FIELDS;
export interface TranslationArgs { title: string; reason: string; entity: 'product' | 'category'; changes: { id: string; store: string; fields: Record<string, unknown> }[] }
export interface TranslationPayload { refs: Record<string, string> }

/** Store-Views mit Locale (ohne admin) */
export async function storeViewList(ro: MagentoReader) {
  const [views, cfgs] = await Promise.all([ro.storeViews(), ro.storeConfigs()]);
  return views.filter(v => v.code !== 'admin' && Number(v.id) !== 0).map(v => ({ id: Number(v.id), code: String(v.code), name: String(v.name), active: !!v.is_active, websiteId: Number(v.website_id), locale: cfgs.find(c => c.code === v.code)?.locale ?? null, isDefault: v.code === ro.storeCode }));
}

export async function buildTranslationChangeSet(ro: MagentoReader, a: TranslationArgs): Promise<{ cs: ChangeSet; payload: TranslationPayload }> {
  if (!a.changes?.length) throw new Error('changes ist leer');
  const views = await storeViewList(ro), FIELDS = TR_FIELDS[a.entity];
  if (!FIELDS) throw new Error('entity: product oder category');
  const items: ChangeItem[] = [], skipped: { id: string; reason: string }[] = [], refs: Record<string, string> = {}; let unchanged = 0;
  for (const ch of a.changes) {
    const view = views.find(v => v.code === ch.store || String(v.id) === String(ch.store) || (v.locale && v.locale.toLowerCase().replace('_', '-') === String(ch.store).toLowerCase().replace('_', '-')));
    if (!view) { skipped.push({ id: String(ch.id), reason: `Store-View „${ch.store}“ gibt es nicht (vorhanden: ${views.map(v => `${v.code} (${v.locale})`).join(', ')})` }); continue; }
    const base = a.entity === 'product' ? await ro.productByRef(String(ch.id)) : await ro.category(ch.id, 'all');
    if (!base) { skipped.push({ id: String(ch.id), reason: 'nicht gefunden' }); continue; }
    const ref = a.entity === 'product' ? String(base.sku) : String(base.id), id = String(base.id);
    const [inView, glob] = await Promise.all(a.entity === 'product' ? [ro.product(ref, view.code), ro.product(ref, 'all')] : [ro.category(ref, view.code), ro.category(ref, 'all')]);
    if (!inView || !glob) { skipped.push({ id, reason: 'nicht lesbar' }); continue; }
    refs[id] = ref;
    const label = `${a.entity === 'product' ? productLabel(glob) : glob.name} · ${view.name}${view.locale ? ` (${view.locale})` : ''}`;
    for (const [field, raw] of Object.entries(ch.fields ?? {})) {
      const def = FIELDS[field];
      if (!def) { skipped.push({ id, reason: `Feld "${field}" nicht übersetzbar` }); continue; }
      try {
        const cur = attr(inView, def.attr!), g = attr(glob, def.attr!), own = !sameValue(cur, g);
        const sticky = a.entity === 'category' && def.attr === 'name'; // Magento-REST kann „Standardwert verwenden“ für Kategorienamen nicht setzen
        if (raw === null) {
          if (!own) { unchanged++; continue; }
          if (sticky) { skipped.push({ id, reason: 'Eigenen Kategorienamen einer Store-View entfernt nur der Magento-Admin („Standardwert verwenden“)' }); continue; }
          items.push({ id: `${id}:${view.code}:${field}`, entity: a.entity, entityId: id, label, field, fieldLabel: def.label, before: cut(cur), after: `erbt wieder: ${cut(g, 120)}`, afterRaw: { store: view.code, attr: def.attr, value: null }, warn: [] });
          continue;
        }
        const v = validate(def, raw);
        if (own && sameValue(cur, v)) { unchanged++; continue; }
        const warn: string[] = [];
        if (sameValue(v, g)) warn.push('Gleicher Text wie die Standardebene (wird trotzdem als eigener Wert der Store-View gespeichert)');
        if (sticky && !own) warn.push('Rückgängig setzt den Namen dieser Store-View auf den globalen Text zurück (bleibt als eigener Wert gespeichert)');
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

// ================= URL-Schlüssel (SEO-URLs) mit Weiterleitung =================
export interface SeoUrlArgs { title: string; reason: string; entity: 'product' | 'category'; changes: { id: string; urlKey: string }[] }
export async function buildSeoUrlChangeSet(ro: MagentoReader, a: SeoUrlArgs): Promise<{ cs: ChangeSet; payload: CatalogPayload }> {
  if (!a.changes?.length) throw new Error('changes ist leer');
  if (a.changes.length > MAX_ITEMS) throw new Error(`Maximal ${MAX_ITEMS} pro Änderungsset.`);
  const sf = await ro.storefrontConfig().catch(() => ({} as { product_url_suffix?: string | null; category_url_suffix?: string | null }));
  const suffix = (a.entity === 'product' ? sf.product_url_suffix : sf.category_url_suffix) ?? '';
  const items: ChangeItem[] = [], skipped: { id: string; reason: string }[] = [], skus: Record<string, string> = {}, seen = new Set<string>(); let unchanged = 0;
  for (const ch of a.changes) {
    const rec = a.entity === 'product' ? await ro.productByRef(String(ch.id)) : await ro.category(ch.id);
    if (!rec) { skipped.push({ id: String(ch.id), reason: 'nicht gefunden' }); continue; }
    const id = String(rec.id), key = urlKey(String(ch.urlKey ?? '').replace(/\.html?$/i, '').split('/').pop() ?? '');
    if (a.entity === 'product') skus[id] = rec.sku;
    if (!key) { skipped.push({ id, reason: 'URL-Schlüssel leer' }); continue; }
    const cur = attrStr(rec, 'url_key');
    if (cur === key) { unchanged++; continue; }
    if (seen.has(key)) { skipped.push({ id, reason: `„${key}“ doppelt im Set` }); continue; }
    const clash = a.entity === 'product' ? (await ro.products({ filters: [[{ field: 'url_key', value: key }]], pageSize: 2 })).items.filter(x => String(x.id) !== id)
      : (await ro.categories({ filters: [[{ field: 'url_key', value: key }]], pageSize: 5 })).items.filter(x => String(x.id) !== id && Number(x.parent_id) === Number(rec.parent_id));
    if (clash.length) { skipped.push({ id, reason: `URL-Schlüssel „${key}“ ist schon vergeben (${clash[0].name ?? clash[0].sku ?? clash[0].id})` }); continue; }
    seen.add(key);
    const path = a.entity === 'category' ? String(attrStr(rec, 'url_path') ?? cur ?? '').split('/').slice(0, -1).concat(key).join('/') : key;
    items.push({ id: `${id}:urlKey`, entity: a.entity, entityId: id, label: a.entity === 'product' ? productLabel(rec) : String(rec.name), field: 'urlKey', fieldLabel: 'URL-Schlüssel', before: `${cur ?? '–'}${cur ? suffix : ''}`, after: `${path}${suffix}`, afterRaw: key,
      warn: [`Alte URL leitet per 301 auf die neue weiter${a.entity === 'category' ? ' (auch für Unterkategorien und Produkt-URLs mit Kategoriepfad)' : ''}`] });
  }
  if (!items.length) throw new Error(`Keine Änderung nötig bzw. nichts anwendbar (${unchanged} unverändert, ${skipped.length} übersprungen: ${skipped.slice(0, 3).map(s => s.reason).join('; ')})`);
  items.push({ id: 'info:undo', entity: 'info', label: 'Rückgängig', fieldLabel: '', before: '', after: 'Rückgängig stellt den alten URL-Schlüssel wieder her; die zwischenzeitliche URL leitet dann per 301 auf die alte weiter.', warn: [] });
  return { cs: { id: newIdSafe(), kind: 'seo-urls', entity: a.entity, noun: { one: 'URL', many: 'URLs' }, title: a.title, reason: a.reason, items, skipped, unchanged, atomic: false }, payload: { store: ro.storeCode, skus } };
}
reg.register('seo-urls', (c, cs, payload, selected, ctx) => {
  const p = payload as CatalogPayload, e = cs.entity as 'product' | 'category';
  return applyEach(cs, selected, it => writeScoped(c, e, e === 'product' ? p.skus![it.entityId!] : it.entityId!, p.store, { url_key: it.afterRaw }, {}, { save_rewrites_history: true }), ctx);
});

// ================= Kategorie-Zuordnung von Produkten =================
export interface CategoryProductsArgs { title: string; reason: string; categoryId: string; add?: { productId: string; position?: number }[]; remove?: string[] }
export async function buildCategoryProductsChangeSet(ro: MagentoReader, a: CategoryProductsArgs): Promise<{ cs: ChangeSet; payload: { categoryId: string } }> {
  const cat = await ro.category(a.categoryId);
  if (!cat) throw new Error('Kategorie nicht gefunden');
  if (Number(cat.level) < 2) throw new Error('Der Wurzelkategorie werden keine Produkte zugeordnet');
  const links = await ro.categoryProducts(cat.id), linked = new Map(links.map(l => [l.sku, l]));
  const refs = [...(a.add ?? []).map(x => String(x.productId)), ...(a.remove ?? []).map(String)];
  if (refs.length > MAX_ITEMS) throw new Error(`Maximal ${MAX_ITEMS} Produkte pro Änderungsset.`);
  const byRef = new Map<string, MProduct>();
  for (const p of await ro.productsByIds(refs)) byRef.set(String(p.id), p);
  for (const p of await ro.productsBySkus(refs.filter(r => !byRef.has(r)))) byRef.set(p.sku, p);
  const items: ChangeItem[] = [], skipped: { id: string; reason: string }[] = [];
  for (const x of a.add ?? []) {
    const p = byRef.get(String(x.productId)); if (!p) { skipped.push({ id: String(x.productId), reason: 'nicht gefunden' }); continue; }
    if (linked.has(p.sku)) { skipped.push({ id: String(p.id), reason: 'schon zugeordnet' }); continue; }
    items.push({ id: `add:${p.id}`, entity: 'product', entityId: String(p.id), label: productLabel(p), field: 'category', fieldLabel: `Kategorie „${cat.name}“`, before: 'nicht zugeordnet', after: 'zugeordnet', afterRaw: { sku: p.sku, position: x.position ?? 0, add: true }, warn: Number(p.visibility) === 1 ? ['Einzeln nicht sichtbar (Sichtbarkeit „nicht einzeln sichtbar“)'] : [] });
  }
  for (const r of a.remove ?? []) {
    const p = byRef.get(String(r)); if (!p) { skipped.push({ id: String(r), reason: 'nicht gefunden' }); continue; }
    const l = linked.get(p.sku); if (!l) { skipped.push({ id: String(p.id), reason: 'nicht zugeordnet' }); continue; }
    items.push({ id: `rm:${p.id}`, entity: 'product', entityId: String(p.id), label: productLabel(p), field: 'category', fieldLabel: `Kategorie „${cat.name}“`, before: 'zugeordnet', after: 'entfernt', afterRaw: { sku: p.sku, position: l.position ?? 0, add: false }, warn: [] });
  }
  if (!items.length) throw new Error(`Nichts zu ändern (${skipped.map(s => s.reason).slice(0, 3).join('; ') || 'leer'})`);
  return { cs: { id: newIdSafe(), kind: 'category-products', entity: 'category', noun: { one: 'Zuordnung', many: 'Zuordnungen' }, title: a.title, reason: a.reason, items, skipped, atomic: false }, payload: { categoryId: String(cat.id) } };
}
reg.register('category-products', async (c, cs, payload, selected, ctx) => {
  const cid = Number((payload as { categoryId: string }).categoryId);
  // nacheinander: Magento speichert dabei jedes Mal die ganze Kategorie, parallel schlägt das fehl
  const results: ApplyResult['results'] = [], undo: UndoOp[] = [], list = cs.items.filter(i => selected.has(i.id) && i.entity !== 'info'), tick = partialTicker(ctx, list.length, { results, undo });
  for (const it of list) {
    try { undo.push(await linkOne(it)); results.push({ itemId: it.id, ok: true }); } catch (e) { results.push({ itemId: it.id, ok: false, error: errMsg(e) }); } finally { tick(); }
  }
  return { results, undo };
  async function linkOne(it: ChangeItem): Promise<UndoOp> {
    const { sku, position, add } = it.afterRaw as { sku: string; position: number; add: boolean };
    const link = (pos: number) => ({ productLink: { sku, position: pos, category_id: String(cid) } });
    if (add) { await c.req('POST', `/V1/categories/${cid}/products`, link(position), { store: 'all' }); return reqOp('category-product', sku, 'DELETE', `/all/V1/categories/${cid}/products/${skuPath(sku)}`); }
    const cur = ((await c.req('GET', `/V1/categories/${cid}/products`, undefined, { store: 'all' })) as { sku: string; position: number }[]).find(l => l.sku === sku);
    await c.req('DELETE', `/V1/categories/${cid}/products/${skuPath(sku)}`, undefined, { store: 'all' });
    return reqOp('category-product', sku, 'POST', `/all/V1/categories/${cid}/products`, link(cur?.position ?? position));
  }
});

/** Ausgabe-Hilfen für Werkzeuge */
export const priceView = (p: MRecord) => { const s = priceState(p); return { price: money(s.selling), priceValue: s.selling, listPrice: s.list, regularPrice: s.regular, specialPrice: s.special, specialFrom: s.from, specialTo: s.to, specialActive: s.active }; };

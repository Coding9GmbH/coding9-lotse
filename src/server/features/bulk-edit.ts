import 'server-only';
// Stapelverarbeitung: eine Regel auf ALLE Produkte eines Filters anwenden (auch weit über MAX_ITEMS).
// Die Karte zeigt nur Gruppen + Stichprobe; geschrieben wird in Blöcken à 50 per Sync-API, Rückgängig je Block exakt.
import type { ChangeItem, ChangeSet, UndoOp } from '@/lib/protocol';
import { DEFAULT_CURRENCY, STALE, WRITE_CONCURRENCY, errMsg, eur, isStale, net, pool, resolvePrice, type ApplyCtx, type ApplyResult } from '../changes';
import { newId, type Shopware, type ShopReader, type SwEntity } from '../shopware';

export const BULK_KIND = 'bulk-products';
export const BULK_MAX = 10_000;      // höchstens so viele Produkte je Änderungsset
export const BULK_SCAN = 20_000;     // höchstens so viele Produkte werden geprüft
export const CHUNK = 50;
export const SAMPLE = 50;
const PAGE = 500;
const HEX = /^[0-9a-f]{32}$/i;

export interface BulkFilter {
  categoryId?: string; term?: string; minPrice?: number; maxPrice?: number; active?: boolean; minStock?: number; maxStock?: number;
  manufacturer?: string; properties?: string[]; variantOptions?: string[]; includeVariants?: boolean;
}
export interface PriceRule { percent?: number; add?: number; set?: number; round?: string }
export interface BulkChange {
  price?: PriceRule; listPrice?: PriceRule | null | 'currentPrice'; active?: boolean; stock?: { set?: number; add?: number };
  deliveryTime?: string; shippingFree?: boolean; markAsTopseller?: boolean;
}
/** Plan je Produkt: nur die Felder, die sich ändern (price.list: undefined = Streichpreis behalten, null = entfernen).
 *  stockAdd: relativ – erst beim Anwenden auf den dann aktuellen Bestand gerechnet (Bestellungen dazwischen gehen nicht verloren).
 *  prev: wirksame Werte beim Vorschlag für die geplanten Felder (Stale-Write-Guard je Block; stockAdd ohne prev.stock) */
export interface BulkPlan {
  id: string; group: 'ok' | 'warn';
  price?: { gross?: number; list?: number | null };
  active?: boolean; stock?: number; stockAdd?: number; deliveryTimeId?: string; shippingFree?: boolean; markAsTopseller?: boolean;
  prev?: Partial<Record<PrevKey, unknown>>;
}
type PrevKey = 'gross' | 'list' | 'active' | 'stock' | 'deliveryTimeId' | 'shippingFree' | 'markAsTopseller';
const PREV_LABEL: Record<PrevKey, string> = { gross: 'Preis', list: 'Streichpreis', active: 'Aktiv', stock: 'Bestand', deliveryTimeId: 'Lieferzeit', shippingFree: 'Versandkostenfrei', markAsTopseller: 'Topseller' };
export interface BulkPayload { plans: BulkPlan[] }

const FIELD_LABEL: Record<string, string> = { price: 'Preis', listPrice: 'Streichpreis', active: 'Aktiv', stock: 'Bestand', deliveryTime: 'Lieferzeit', shippingFree: 'Versandkostenfrei', markAsTopseller: 'Topseller' };
const sign = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '±');
const num = (n: number) => Math.abs(n).toLocaleString('de-DE', { maximumFractionDigits: 2 });
const yesNo = (b: boolean | null | undefined) => (b ? 'ja' : 'nein');
const roundText = (r?: string) => (r && r !== 'none' ? `, gerundet auf ${r}` : '');
function ruleText(r: PriceRule) {
  if (r.set != null) return `= ${eur(r.set)}${roundText(r.round)}`;
  if (r.percent != null) return `${sign(r.percent)}${num(r.percent)} %${roundText(r.round)}`;
  if (r.add != null) return `${sign(r.add)}${num(r.add)} €${roundText(r.round)}`;
  return '?';
}
/** Regel in Worten, z. B. „Preis −10 %, gerundet auf .99 · Streichpreis = bisheriger Preis“ */
export function describeChange(c: BulkChange, deliveryTimeName?: string): string {
  const out: string[] = [];
  if (c.price) out.push(`Preis ${ruleText(c.price)}`);
  if (c.listPrice !== undefined) out.push(`Streichpreis ${c.listPrice === null ? 'entfernen' : c.listPrice === 'currentPrice' ? '= bisheriger Preis' : ruleText(c.listPrice)}`);
  if (c.active !== undefined) out.push(c.active ? 'aktivieren' : 'deaktivieren');
  if (c.stock) out.push(c.stock.set != null ? `Bestand = ${c.stock.set}` : `Bestand ${sign(c.stock.add ?? 0)}${Math.abs(c.stock.add ?? 0)}`);
  if (c.deliveryTime !== undefined) out.push(`Lieferzeit = ${deliveryTimeName ?? c.deliveryTime}`);
  if (c.shippingFree !== undefined) out.push(`Versandkostenfrei: ${yesNo(c.shippingFree)}`);
  if (c.markAsTopseller !== undefined) out.push(`Topseller: ${yesNo(c.markAsTopseller)}`);
  return out.join(' · ');
}

/** Prüft die Regel vor dem Lesen (klare Fehlermeldung statt halber Ergebnisse) */
export function validateChange(c: BulkChange) {
  const keys = Object.keys(c ?? {}).filter(k => (c as Record<string, unknown>)[k] !== undefined);
  if (!keys.length) throw new Error('change ist leer');
  const bad = keys.filter(k => !(k in FIELD_LABEL)); if (bad.length) throw new Error(`Nicht erlaubte Felder: ${bad.join(', ')}`);
  const rule = (r: unknown, label: string) => {
    if (!r || typeof r !== 'object') throw new Error(`${label}: Regel {percent|add|set, round?} erwartet`);
    const x = r as PriceRule, n = [x.percent, x.add, x.set].filter(v => v != null).length;
    if (n !== 1) throw new Error(`${label}: genau eine von percent, add oder set angeben`);
    if ([x.percent, x.add, x.set].some(v => v != null && !Number.isFinite(v))) throw new Error(`${label}: Zahl erwartet`);
    if (x.set != null && x.set < 0) throw new Error(`${label}: set ≥ 0 erwartet`);
    if (x.percent != null && x.percent <= -100) throw new Error(`${label}: percent muss größer als −100 sein`);
    if (x.round != null && x.round !== 'none' && !/^\.\d{2}$/.test(x.round)) throw new Error(`${label}: round z. B. ".99", ".95", ".00" oder "none"`);
  };
  if (c.price !== undefined) rule(c.price, 'Preis');
  if (c.listPrice !== undefined && c.listPrice !== null && c.listPrice !== 'currentPrice') rule(c.listPrice, 'Streichpreis');
  if (c.stock !== undefined) {
    const n = [c.stock?.set, c.stock?.add].filter(v => v != null).length;
    if (n !== 1 || ![c.stock.set ?? 0, c.stock.add ?? 0].every(Number.isInteger)) throw new Error('Bestand: {set: ganze Zahl ≥ 0} oder {add: ganze Zahl}');
    if (c.stock.set != null && c.stock.set < 0) throw new Error('Bestand: set ≥ 0 erwartet');
  }
  for (const k of ['active', 'shippingFree', 'markAsTopseller'] as const) if (c[k] !== undefined && typeof c[k] !== 'boolean') throw new Error(`${k}: true/false erwartet`);
}

/** DAL-Filter für die Hauptprodukte (Preis/Aktiv/Bestand prüft der Server danach auf den wirksamen, ggf. geerbten Werten) */
export function bulkCriteria(f: BulkFilter, manufacturerId?: string | null) {
  const filter: Record<string, unknown>[] = [{ type: 'equals', field: 'parentId', value: null }];
  if (f.categoryId) filter.push({ type: 'equals', field: 'categoriesRo.id', value: f.categoryId });
  if (manufacturerId) filter.push({ type: 'equals', field: 'manufacturerId', value: manufacturerId });
  if (f.properties?.length) filter.push({ type: 'equalsAny', field: 'properties.id', value: f.properties });
  if (!f.includeVariants && f.active != null) filter.push({ type: 'equals', field: 'active', value: f.active });
  if (!f.includeVariants && (f.minStock != null || f.maxStock != null)) filter.push({ type: 'range', field: 'stock', parameters: { ...(f.minStock != null ? { gte: f.minStock } : {}), ...(f.maxStock != null ? { lte: f.maxStock } : {}) } });
  return { filter, ...(f.term ? { term: f.term } : {}) };
}

const INCLUDES = { product: ['id', 'parentId', 'productNumber', 'name', 'translated', 'price', 'purchasePrices', 'stock', 'active', 'taxId', 'tax', 'childCount', 'deliveryTimeId', 'shippingFree', 'markAsTopseller'], tax: ['id', 'taxRate'] };

const tooMany = () => new Error(`Mehr als ${BULK_SCAN.toLocaleString('de-DE')} Produkte passen auf den Filter, bitte enger filtern (z. B. Kategorie, Hersteller, Preisspanne).`);
/** cap = noch verfügbarer Rest des Gesamtdeckels BULK_SCAN (die Meldung nennt immer den Gesamtdeckel) */
async function pageAll(ro: ShopReader, criteria: Record<string, unknown>, cap: number) {
  const out: SwEntity[] = []; let total = 0;
  for (let page = 1; ; page++) {
    const r = await ro.search('product', { ...criteria, limit: PAGE, page, sort: [{ field: 'id', order: 'ASC' }], 'total-count-mode': 1, associations: { tax: {} }, includes: INCLUDES });
    total = r.total ?? total; out.push(...r.data);
    if (out.length > cap) throw tooMany();
    if (r.data.length < PAGE) break;
  }
  return { rows: out, total };
}

/** Alle passenden Produkte (paginiert) – Varianten der passenden Hauptprodukte auf Wunsch dazu */
export async function resolveProducts(ro: ShopReader, f: BulkFilter) {
  let manufacturerId: string | null = null;
  if (f.manufacturer) {
    if (HEX.test(f.manufacturer)) manufacturerId = f.manufacturer;
    else {
      const m = (await ro.search('product-manufacturer', { limit: 25, filter: [{ type: 'contains', field: 'name', value: f.manufacturer.trim() }] })).data;
      const hit = m.find(x => String(x.translated?.name ?? x.name).toLocaleLowerCase('de-DE') === f.manufacturer!.trim().toLocaleLowerCase('de-DE')) ?? (m.length === 1 ? m[0] : null);
      if (!hit) throw new Error(`Hersteller „${f.manufacturer}“ nicht eindeutig gefunden${m.length ? ` (Treffer: ${m.slice(0, 5).map(x => x.translated?.name ?? x.name).join(', ')})` : ''}`);
      manufacturerId = hit.id;
    }
  }
  const main = (await pageAll(ro, bulkCriteria(f, manufacturerId), BULK_SCAN)).rows;
  const parents: Record<string, SwEntity> = Object.fromEntries(main.map(p => [p.id, p]));
  const variants: SwEntity[] = [];
  // Rest des Gesamtdeckels für Varianten; ist er aufgebraucht, sofort mit klarer Meldung abbrechen (nie „Mehr als 0 Produkte“)
  const left = () => { const n = BULK_SCAN - main.length - variants.length; if (n <= 0) throw tooMany(); return n; };
  if (f.term && f.includeVariants) {
    // wie list_products: Suchbegriff trifft auch Varianten direkt (z. B. „HH-PLAID-130.1“); ihr Hauptprodukt muss die übrigen Filter erfüllen
    const hits = (await pageAll(ro, { term: f.term, filter: [{ type: 'not', operator: 'and', queries: [{ type: 'equals', field: 'parentId', value: null }] }] }, left())).rows;
    const pids = [...new Set(hits.map(v => v.parentId as string).filter(id => !parents[id]))];
    const base = bulkCriteria(f, manufacturerId).filter;
    for (let i = 0; i < pids.length; i += PAGE)
      (await pageAll(ro, { filter: [...base, { type: 'equalsAny', field: 'id', value: pids.slice(i, i + PAGE) }] }, BULK_SCAN)).rows.forEach(p => { parents[p.id] = p; });
    variants.push(...hits.filter(v => parents[v.parentId] && !(f.variantOptions?.length)));
  }
  if (f.includeVariants || f.variantOptions?.length) {
    const ids = main.map(p => p.id); // childCount wird asynchron indiziert – daher direkt nach Varianten der Treffer suchen
    for (let i = 0; i < ids.length; i += PAGE) {
      const filter: Record<string, unknown>[] = [{ type: 'equalsAny', field: 'parentId', value: ids.slice(i, i + PAGE) }];
      if (f.variantOptions?.length) filter.push({ type: 'equalsAny', field: 'options.id', value: f.variantOptions });
      const seen = new Set(variants.map(v => v.id));
      variants.push(...(await pageAll(ro, { filter }, left())).rows.filter(v => !seen.has(v.id)));
    }
  }
  const all = f.variantOptions?.length ? variants : [...main, ...variants];
  const matched = all.filter(p => {
    const e = effective(p, parents[p.parentId]);
    return (f.minPrice == null || (e.gross != null && e.gross >= f.minPrice)) && (f.maxPrice == null || (e.gross != null && e.gross <= f.maxPrice))
      && (f.active == null || e.active === f.active) && (f.minStock == null || p.stock >= f.minStock) && (f.maxStock == null || p.stock <= f.maxStock);
  });
  return { rows: matched, parents, scanned: all.length };
}

/** Wirksame Werte (Variante erbt null-Felder vom Hauptprodukt) */
export function effective(p: SwEntity, parent?: SwEntity) {
  const inh = <T,>(k: string): T => (p[k] ?? (p.parentId ? parent?.[k] : undefined)) as T;
  const priceArr: SwEntity[] | undefined = p.price ?? (p.parentId ? parent?.price : undefined);
  const purchase: SwEntity[] | undefined = p.purchasePrices ?? (p.parentId ? parent?.purchasePrices : undefined);
  return {
    gross: priceArr?.[0]?.gross ?? null as number | null, list: priceArr?.[0]?.listPrice?.gross ?? null as number | null, priceInherited: !p.price && !!p.parentId,
    purchase: purchase?.[0]?.gross ?? null as number | null, active: inh<boolean | null>('active') ?? null, deliveryTimeId: inh<string | null>('deliveryTimeId') ?? null,
    shippingFree: !!inh<boolean>('shippingFree'), markAsTopseller: !!inh<boolean>('markAsTopseller'), name: String(p.translated?.name ?? p.name ?? parent?.translated?.name ?? parent?.name ?? ''),
  };
}

export interface PlanRow { plan: BulkPlan | null; before: string[]; after: string[]; fields: string[]; warn: string[]; skip?: string; label: string; gross?: [number | null, number | null]; follows?: boolean }
/** Plan für ein Produkt (rein, testbar). inSet: Hauptprodukt wird mitgeändert → geerbte Werte folgen ihm automatisch. */
export function planProduct(p: SwEntity, parent: SwEntity | undefined, c: BulkChange, inSet: boolean, dtNames: Record<string, string> = {}): PlanRow {
  const e = effective(p, parent), follows = !!p.parentId && inSet;
  const row: PlanRow = { plan: null, before: [], after: [], fields: [], warn: [], label: `${e.name}${p.parentId ? ', Variante' : ''} (${p.productNumber})` };
  const plan: BulkPlan = { id: p.id, group: 'ok', prev: {} };
  const put = (field: string, before: string, after: string) => { row.fields.push(FIELD_LABEL[field]); row.before.push(before); row.after.push(after); };
  const prev = (k: PrevKey, v: unknown) => { plan.prev![k] = v ?? null; };
  // Variante erbt einen geänderten Wert vom mitgeänderten Hauptprodukt → folgt automatisch (wird nicht geschrieben)
  row.follows = follows && (((!!c.price || c.listPrice !== undefined) && e.priceInherited) || (c.active !== undefined && p.active == null) || (c.deliveryTime !== undefined && p.deliveryTimeId == null)
    || (['shippingFree', 'markAsTopseller'] as const).some(k => c[k] !== undefined && p[k] == null));
  try {
    // Preis + Streichpreis (geerbter Preis folgt dem mitgeänderten Hauptprodukt)
    if ((c.price || c.listPrice !== undefined) && !(e.priceInherited && follows)) {
      if (e.gross == null) throw new Error('kein Preis vorhanden');
      const gross = c.price ? resolvePrice(e.gross, c.price)! : e.gross;
      if (gross < 0 || !Number.isFinite(gross)) throw new Error(`Preis würde negativ (${eur(gross)})`);
      let list: number | null | undefined;
      if (c.listPrice === null) list = null;
      else if (c.listPrice === 'currentPrice') list = e.gross;
      else if (c.listPrice) {
        if (c.listPrice.set == null && e.list == null) list = undefined; // Regel ohne vorhandenen Streichpreis: nichts zu tun
        else list = resolvePrice(e.list, c.listPrice);
        if (list != null && list < 0) throw new Error('Streichpreis würde negativ');
      }
      const tag = e.priceInherited ? ' (geerbt)' : '';
      if (gross !== e.gross) {
        plan.price = { gross }; prev('gross', e.gross); put('price', `${eur(e.gross)}${tag}`, eur(gross)); row.gross = [e.gross, gross];
        if (gross < 0.01) row.warn.push('Preis unter 0,01 €');
        if (e.purchase != null && gross < e.purchase) row.warn.push(`unter Einkaufspreis (${eur(e.purchase)})`);
        if (e.gross > 0 && Math.abs((gross - e.gross) / e.gross) >= 0.3) row.warn.push(`Preisänderung ${gross > e.gross ? '+' : '−'}${Math.abs(((gross - e.gross) / e.gross) * 100).toFixed(0)} %`);
      }
      if (list !== undefined && list !== e.list) {
        plan.price = { ...plan.price, list }; prev('list', e.list); put('listPrice', `${eur(e.list)}${tag}`, list === null ? 'entfernt' : eur(list));
        if (list != null && list <= gross) row.warn.push('Streichpreis ≤ Preis');
        if (e.priceInherited && plan.price.gross === undefined) row.warn.push(`Preis wird fixiert (bisher geerbt: ${eur(e.gross)})`);
      }
    }
    if (c.active !== undefined && !(follows && p.active == null) && c.active !== e.active) { plan.active = c.active; prev('active', e.active); put('active', yesNo(e.active), yesNo(c.active)); }
    if (c.stock) {
      let s = c.stock.set != null ? c.stock.set : (p.stock ?? 0) + (c.stock.add ?? 0);
      if (s < 0) { row.warn.push('Bestand wäre negativ → 0'); s = 0; }
      if (s !== p.stock) {
        if (c.stock.set != null) { plan.stock = s; prev('stock', p.stock); } else plan.stockAdd = c.stock.add;
        put('stock', String(p.stock ?? '–'), String(s)); if (p.stock > 0 && s === 0) row.warn.push('Bestand auf 0');
      }
    }
    if (c.deliveryTime !== undefined && !(follows && p.deliveryTimeId == null) && c.deliveryTime !== e.deliveryTimeId) { plan.deliveryTimeId = c.deliveryTime; prev('deliveryTimeId', e.deliveryTimeId); put('deliveryTime', dtNames[e.deliveryTimeId ?? ''] ?? '–', dtNames[c.deliveryTime] ?? c.deliveryTime); }
    for (const k of ['shippingFree', 'markAsTopseller'] as const)
      if (c[k] !== undefined && !(follows && p[k] == null) && c[k] !== e[k]) { plan[k] = c[k]; prev(k, e[k]); put(k, yesNo(e[k]), yesNo(c[k])); }
  } catch (err) { row.skip = errMsg(err); return row; }
  if (row.fields.length) { plan.group = row.warn.length ? 'warn' : 'ok'; row.plan = plan; }
  return row;
}

const stat = (vals: number[]) => (vals.length ? `Ø ${eur(vals.reduce((a, b) => a + b, 0) / vals.length)} (${eur(Math.min(...vals))} – ${eur(Math.max(...vals))})` : '–');
const counts = (vals: string[]) => Object.entries(vals.reduce<Record<string, number>>((m, v) => ({ ...m, [v]: (m[v] ?? 0) + 1 }), {})).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([v, n]) => `${n}× ${v}`).join(', ');

/** Änderungsset: Gruppen (ohne/mit Warnungen, abwählbar) + Stichprobe; Plan aller Produkte als Payload */
export function bulkChangeSet(title: string, reason: string, c: BulkChange, rows: SwEntity[], parents: Record<string, SwEntity>, dtNames: Record<string, string> = {}, hints: string[] = []): { cs: ChangeSet; payload: BulkPayload } {
  const ids = new Set(rows.map(r => r.id));
  const sorted = [...rows].sort((a, b) => String(a.productNumber).localeCompare(String(b.productNumber), 'de', { numeric: true }));
  const planned = sorted.map(p => ({ p, r: planProduct(p, parents[p.parentId], c, !!p.parentId && ids.has(p.parentId), dtNames) }));
  const todo = planned.filter(x => x.r.plan), skippedRows = planned.filter(x => x.r.skip), following = planned.filter(x => x.r.follows && !x.r.skip);
  let unchanged = planned.length - todo.length - skippedRows.length - following.filter(x => !x.r.plan).length;
  if (following.length) hints = [...hints, `${following.length.toLocaleString('de-DE')} ${following.length === 1 ? 'Variante erbt' : 'Varianten erben'} geänderte Werte vom Hauptprodukt und ${following.length === 1 ? 'folgt' : 'folgen'} automatisch (nicht mitgezählt).`];
  if (todo.length > BULK_MAX) throw new Error(`${todo.length.toLocaleString('de-DE')} Produkte – maximal ${BULK_MAX.toLocaleString('de-DE')} pro Änderungsset. Bitte enger filtern oder aufteilen.`);
  const skipped = skippedRows.slice(0, 100).map(x => ({ id: x.p.id, reason: `${x.r.label}: ${x.r.skip}` }));
  if (skippedRows.length > 100) skipped.push({ id: 'more', reason: `… und ${skippedRows.length - 100} weitere` });
  if (!todo.length) throw new Error(`Keine Änderung nötig bzw. nichts anwendbar (${planned.length} passende Produkte, ${unchanged} unverändert, ${skippedRows.length} übersprungen${skipped[0] ? `: ${skipped.slice(0, 3).map(s => s.reason).join('; ')}` : ''})`);
  const rule = describeChange(c, c.deliveryTime ? dtNames[c.deliveryTime] : undefined);
  const items: ChangeItem[] = [];
  for (const g of ['ok', 'warn'] as const) {
    const xs = todo.filter(x => x.r.plan!.group === g); if (!xs.length) continue;
    const grossPairs = xs.map(x => x.r.gross).filter((v): v is [number, number] => !!v && v[0] != null && v[1] != null);
    const before = grossPairs.length ? stat(grossPairs.map(v => v[0])) : counts(xs.map(x => x.r.before.join(' · ')));
    const after = grossPairs.length ? stat(grossPairs.map(v => v[1])) : counts(xs.map(x => x.r.after.join(' · ')));
    const warn = g === 'warn' ? Object.entries(xs.flatMap(x => x.r.warn.map(w => w.replace(/\s*\(.*\)$|[+−]\d+ %$/, '').trim())).reduce<Record<string, number>>((m, w) => ({ ...m, [w]: (m[w] ?? 0) + 1 }), {})).map(([w, n]) => `${n.toLocaleString('de-DE')}× ${w}`) : [];
    items.push({ id: `grp:${g}`, entity: 'product', label: `${xs.length.toLocaleString('de-DE')} ${xs.length === 1 ? 'Produkt' : 'Produkte'} ${g === 'ok' ? 'ohne Auffälligkeiten' : 'mit Warnungen'}`, field: 'bulk', fieldLabel: rule, before, after, afterRaw: { count: xs.length }, warn });
  }
  for (const h of hints) items.push({ id: `hint:${items.length}`, entity: 'info', label: 'Hinweis', fieldLabel: '', before: '', after: h, warn: [] });
  // Stichprobe: die ersten 50 + bis zu 10 weitere mit Warnungen – nie Tausende Zeilen in der Karte
  const first = todo.slice(0, SAMPLE), extra = todo.slice(SAMPLE).filter(x => x.r.warn.length).slice(0, 10);
  const sample: ChangeItem[] = [...first, ...extra].map(({ p, r }) => ({ id: p.id, entity: 'info', entityId: p.id, label: r.label, fieldLabel: r.fields.join(', '), before: r.before.join(' · '), after: r.after.join(' · '), warn: r.warn }));
  unchanged = Math.max(0, unchanged);
  const cs: ChangeSet = { id: newId(), kind: BULK_KIND, entity: 'product', noun: { one: 'Produkt', many: 'Produkte' }, title, reason, items, sample, total: todo.length, skipped, unchanged, atomic: false,
    applyLabel: `${todo.length.toLocaleString('de-DE')} ${todo.length === 1 ? 'Produkt' : 'Produkte'} ändern` };
  return { cs, payload: { plans: todo.map(x => x.r.plan!) } };
}

// ================= Executor =================
type Money = { currencyId: string; gross: number; net: number; linked?: boolean };
const cleanMoney = (m: SwEntity | null | undefined): Money | undefined => (m ? { currencyId: m.currencyId, gross: m.gross, net: m.net, linked: m.linked ?? true } : undefined);
/** Preis-JSON ohne berechnete Felder (percentage, apiAlias, extensions) – so wird es exakt zurückgeschrieben */
export const cleanPrices = (arr: SwEntity[] | null | undefined) => (arr ? arr.map(p => ({ ...cleanMoney(p)!, ...(p.listPrice ? { listPrice: cleanMoney(p.listPrice) } : {}), ...(p.regulationPrice ? { regulationPrice: cleanMoney(p.regulationPrice) } : {}) })) : null);

/** Schreibdaten + exakte Rückgängig-Daten eines Produkts aus Plan und aktuellem Stand */
export function planWrite(plan: BulkPlan, cur: SwEntity, parent?: SwEntity | null) {
  const row: Record<string, unknown> = { id: plan.id }, back: Record<string, unknown> = { id: plan.id };
  if (plan.price) {
    const prices: SwEntity[] = cur.price ?? parent?.price ?? [];
    const base = prices[0]; if (!base) throw new Error('Kein Preis vorhanden');
    const rate = (cur.tax ?? parent?.tax)?.taxRate ?? 19, currencyId = base.currencyId ?? DEFAULT_CURRENCY;
    const gross = plan.price.gross ?? base.gross, list = plan.price.list === undefined ? base.listPrice?.gross ?? null : plan.price.list;
    const entry = { currencyId, gross, net: net(gross, rate), linked: true, ...(list != null ? { listPrice: { currencyId, gross: list, net: net(list, rate), linked: true } } : {}), ...(base.regulationPrice ? { regulationPrice: cleanMoney(base.regulationPrice) } : {}) };
    row.price = [entry, ...(cleanPrices(prices.slice(1)) ?? [])]; back.price = cleanPrices(cur.price);
  }
  for (const k of ['active', 'stock', 'deliveryTimeId', 'shippingFree', 'markAsTopseller'] as const) if (plan[k] !== undefined) { row[k] = plan[k]; back[k] = cur[k] ?? null; }
  if (plan.stockAdd !== undefined) { row.stock = Math.max(0, (cur.stock ?? 0) + plan.stockAdd); back.stock = cur.stock ?? null; }
  return { row, back };
}
/** Was hat sich seit dem Vorschlag an den geplanten Feldern geändert? null = nichts (rein, testbar) */
export function bulkStale(plan: BulkPlan, cur: SwEntity, parent?: SwEntity | null): string | null {
  const pv = plan.prev; if (!pv) return null;
  const e = effective(cur, parent ?? undefined);
  const now: Record<PrevKey, unknown> = { gross: e.gross, list: e.list, active: e.active, stock: cur.stock ?? null, deliveryTimeId: e.deliveryTimeId, shippingFree: e.shippingFree, markAsTopseller: e.markAsTopseller };
  const k = (Object.keys(pv) as PrevKey[]).find(k => isStale(now[k], pv[k]));
  return k ? PREV_LABEL[k] : null;
}
const syncBody = (rows: Record<string, unknown>[]) => [{ key: 'lotse-bulk', action: 'upsert', entity: 'product', payload: rows }];

export async function applyBulk(swW: Shopware, cs: ChangeSet, payload: BulkPayload, selected: Set<string>, ctx?: ApplyCtx): Promise<ApplyResult> {
  const plans = payload.plans.filter(p => selected.has(`grp:${p.group}`));
  const chunks = Array.from({ length: Math.ceil(plans.length / CHUNK) }, (_, i) => ({ i, list: plans.slice(i * CHUNK, (i + 1) * CHUNK) }));
  const all: ApplyResult['results'] = [], undo: UndoOp[] = [];
  let done = 0; ctx?.progress?.(0, plans.length);
  await pool(chunks, WRITE_CONCURRENCY, async ({ i, list }) => {
    try {
      const ids = list.map(p => p.id);
      const cur = Object.fromEntries((await swW.search('product', { ids, limit: ids.length, associations: { tax: {} } })).data.map(p => [p.id, p]));
      // Hauptprodukt für jede Variante laden: bulkStale/planWrite müssen dieselben geerbten Werte sehen wie planProduct beim Vorschlag
      const pids = [...new Set(list.map(p => cur[p.id]?.parentId as string | undefined).filter((id): id is string => !!id))];
      const parents = pids.length ? Object.fromEntries((await swW.search('product', { ids: pids, limit: pids.length, associations: { tax: {} } })).data.map(p => [p.id, p])) : {};
      const ready: { row: Record<string, unknown>; back: Record<string, unknown> }[] = [];
      for (const p of list) {
        try {
          if (!cur[p.id]) throw new Error('Produkt nicht mehr vorhanden');
          const stale = bulkStale(p, cur[p.id], parents[cur[p.id].parentId]); if (stale) throw new Error(`${stale}: ${STALE}`);
          ready.push(planWrite(p, cur[p.id], parents[cur[p.id].parentId]));
        }
        catch (e) { all.push({ itemId: p.id, ok: false, error: errMsg(e) }); }
      }
      if (ready.length) {
        try { // ein Sync-Aufruf je Block (transaktional); schlägt er fehl, einzeln schreiben, um den Verursacher zu finden
          await swW.req('POST', '/_action/sync', syncBody(ready.map(r => r.row)));
          undo.push({ op: 'req', entity: 'product', id: `bulk-${i + 1}`, method: 'POST', path: '/_action/sync', body: syncBody(ready.map(r => r.back)) });
          ready.forEach(r => all.push({ itemId: r.row.id as string, ok: true }));
        } catch {
          const okBack: Record<string, unknown>[] = [];
          for (const { row, back } of ready) {
            const { id, ...data } = row;
            try { await swW.update('product', id as string, data); okBack.push(back); all.push({ itemId: id as string, ok: true }); }
            catch (e) { all.push({ itemId: id as string, ok: false, error: errMsg(e) }); }
          }
          if (okBack.length) undo.push({ op: 'req', entity: 'product', id: `bulk-${i + 1}`, method: 'POST', path: '/_action/sync', body: syncBody(okBack) });
        }
      }
    } catch (e) { list.forEach(p => all.push({ itemId: p.id, ok: false, error: errMsg(e) })); }
    done += list.length; ctx?.progress?.(done, plans.length, { results: all, undo });
  });
  return { ...bulkResults(cs, plans, all), undo };
}

/** Ergebnis klein halten (Chat, Audit-Log): je Gruppe eine Zeile, dazu Stichprobe und höchstens 100 Fehler – Zahlen in counts */
export function bulkResults(cs: ChangeSet, plans: BulkPlan[], all: ApplyResult['results']): Pick<ApplyResult, 'results' | 'counts'> {
  const bad = new Map(all.filter(r => !r.ok).map(r => [r.itemId, r])), sample = new Set((cs.sample ?? []).map(i => i.id));
  const results: ApplyResult['results'] = [];
  for (const g of ['ok', 'warn'] as const) {
    const ids = plans.filter(p => p.group === g).map(p => p.id); if (!ids.length) continue;
    const f = ids.filter(id => bad.has(id)).length;
    results.push({ itemId: `grp:${g}`, ok: !f, ...(f ? { error: `${f.toLocaleString('de-DE')} von ${ids.length.toLocaleString('de-DE')} fehlgeschlagen` } : {}) });
  }
  results.push(...all.filter(r => sample.has(r.itemId)), ...[...bad.values()].filter(r => !sample.has(r.itemId)).slice(0, 100));
  return { results, counts: { applied: all.length - bad.size, failed: bad.size } };
}

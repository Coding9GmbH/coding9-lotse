// Read Magento records and map Lotse fields to Magento (pure functions, tested in magento.test.ts).
// Important: Magento has no "list price" value. It shows the regular price (price) struck through as soon as a
// special price (special_price, optionally with special_from_date/special_to_date) is active and lower. Lotse semantics:
// price = what the customer pays, listPrice = struck-through price. planPrice() translates this into price/special_price.

/** Magento JSON is dynamic per resource, deliberately loosely typed */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MRecord = Record<string, any>;
export interface MAttr { attribute_code: string; value: unknown }
export interface MGalleryEntry { id: number; media_type?: string; label?: string | null; position?: number; disabled?: boolean; types?: string[]; file?: string }
export interface MProduct extends MRecord { id: number; sku: string; name?: string; price?: number; status?: number; visibility?: number; type_id?: string; custom_attributes?: MAttr[]; media_gallery_entries?: MGalleryEntry[]; extension_attributes?: MRecord }
export interface MCategory extends MRecord { id: number; parent_id?: number; name?: string; is_active?: boolean; level?: number; children_data?: MCategory[]; custom_attributes?: MAttr[] }

/** Attributes that Magento keeps as a field of the record (not under custom_attributes) */
const TOP_LEVEL = new Set(['name', 'price', 'status', 'visibility', 'weight', 'type_id', 'attribute_set_id', 'is_active', 'include_in_menu', 'position']);
export function attr(rec: MRecord | null | undefined, code: string): unknown {
  if (!rec) return undefined;
  if (TOP_LEVEL.has(code)) return rec[code];
  return (rec.custom_attributes as MAttr[] | undefined)?.find(a => a.attribute_code === code)?.value;
}
export const attrStr = (rec: MRecord | null | undefined, code: string): string | null => { const v = attr(rec, code); return v == null || v === '' ? null : String(v); };
const empty = (v: unknown) => v == null || v === '' || (Array.isArray(v) && !v.length);
/** Equality of attribute values (Magento sometimes returns numbers as strings, empty = null) */
export const sameValue = (a: unknown, b: unknown) => (empty(a) && empty(b)) || (!empty(a) && !empty(b) && String(Array.isArray(a) ? a.join(',') : a) === String(Array.isArray(b) ? b.join(',') : b));
/** Write body of a product/category: fields at the top, rest as custom_attributes (null = remove the scope's value → "Use Default Value") */
export function writeBody(values: Record<string, unknown>, top: Record<string, unknown> = {}): MRecord {
  const out: MRecord = { ...top }, ca: MAttr[] = [];
  for (const [k, v] of Object.entries(values)) { if (TOP_LEVEL.has(k)) out[k] = v; else ca.push({ attribute_code: k, value: v }); }
  if (ca.length) out.custom_attributes = ca;
  return out;
}

export { stripHtml as plain } from '@/lib/format';
export const money = (v: number | null | undefined, cur = 'EUR') => (v == null || !Number.isFinite(v) ? null : `${Number(v).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur === 'EUR' ? '€' : cur}`);
const num = (v: unknown) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
/** "2026-10-01 00:00:00" → "2026-10-01" */
export const day = (v: unknown) => (v == null || v === '' ? null : String(v).slice(0, 10));
export const isoDay = (d = new Date(), tz = 'Europe/Berlin') => new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
export const deDay = (d: string | null) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : '–');

// ---- Prices ----
/**
 * Price basis of catalog prices (tax/calculation/price_includes_tax). Magento default is net, not queryable via REST/GraphQL,
 * hence a setting. Unknown = Lotse shows prices with a note and changes none.
 */
export type PriceBasis = 'gross' | 'net';
export const parseBasis = (v: unknown): PriceBasis | null => { const s = String(v ?? '').trim().toLowerCase(); return s === 'gross' || s === 'brutto' ? 'gross' : s === 'net' || s === 'netto' ? 'net' : null; };
export const basisWord = (b: PriceBasis | null) => (b === 'gross' ? 'brutto' : b === 'net' ? 'netto' : 'brutto/netto unbekannt');
export const BASIS_MISSING = 'Preisbasis unbekannt: Erst in Lotse unter Einstellungen → Shop verbinden „Preise im Magento-Admin“ (brutto oder netto) festlegen, bis dahin ändert Lotse keine Preise';
export function needBasis(b: PriceBasis | null): PriceBasis { if (!b) throw new Error(BASIS_MISSING); return b; }
export interface PriceState { regular: number | null; special: number | null; from: string | null; to: string | null; active: boolean; selling: number | null; list: number | null }
/** Current price state: special price active = set, lower than the regular price and today within the date range */
export function priceState(p: MRecord, today = isoDay()): PriceState {
  const regular = num(p.price), special = num(attr(p, 'special_price')), from = day(attr(p, 'special_from_date')), to = day(attr(p, 'special_to_date'));
  const active = special != null && regular != null && special < regular && (!from || from <= today) && (!to || to >= today);
  return { regular, special, from, to, active, selling: active ? special : regular, list: active ? regular : null };
}
export interface PriceWrite { price?: number; special_price?: number | null; special_from_date?: string | null; special_to_date?: string | null }
/**
 * Lotse prices (price = selling price, listPrice = list price, special price date bounds) → Magento values.
 * undefined = unchanged, listPrice null = remove list price. Returns only fields that change, plus notes.
 */
export function planPrice(s: PriceState, want: { price?: number; listPrice?: number | null; from?: string | null; to?: string | null }): { write: PriceWrite; notes: string[] } {
  const selling = want.price ?? s.selling, list = want.listPrice === undefined ? s.list : want.listPrice, notes: string[] = [];
  if (selling == null) throw new Error('Kein aktueller Preis vorhanden');
  const target: PriceWrite = {};
  if (list != null) {
    if (!(list > selling)) throw new Error(`Streichpreis (${money(list)}) muss über dem Preis (${money(selling)}) liegen`);
    target.price = list; target.special_price = selling;
    target.special_from_date = want.from !== undefined ? want.from : s.active ? s.from : null;
    target.special_to_date = want.to !== undefined ? want.to : s.active ? s.to : null;
    notes.push(`Magento: regulärer Preis ${money(list)} (durchgestrichen), Sonderpreis ${money(selling)}`);
  } else if (want.listPrice === null) { // explicitly remove list price: delete the special price including its date range
    if (want.from != null || want.to != null) throw new Error('Zeitraum gilt nur für einen Sonderpreis (listPrice angeben)');
    target.price = selling; target.special_price = null; target.special_from_date = null; target.special_to_date = null;
    if (s.special != null && !s.active) notes.push(`Bisheriger Sonderpreis ${money(s.special)} (derzeit nicht aktiv${s.from ? `, ab ${deDay(s.from)}` : ''}${s.to ? `, bis ${deDay(s.to)}` : ''}) wird entfernt`);
  } else { // price only: a scheduled/expired special price stays as it is
    if (want.from != null || want.to != null) throw new Error('Zeitraum gilt nur für einen Sonderpreis (listPrice angeben)');
    target.price = selling;
    if (s.special != null) notes.push(`Vorhandener Sonderpreis ${money(s.special)}${s.from ? ` ab ${deDay(s.from)}` : ''}${s.to ? ` bis ${deDay(s.to)}` : ''} bleibt unverändert${s.special < selling ? ' und wird im Zeitraum unter diesem Preis angezeigt' : ''}`);
  }
  const cur: PriceWrite = { price: s.regular ?? undefined, special_price: s.special, special_from_date: s.from, special_to_date: s.to };
  const write: PriceWrite = {};
  for (const k of Object.keys(target) as (keyof PriceWrite)[]) if (!sameValue(target[k], cur[k])) (write as Record<string, unknown>)[k] = target[k];
  // Magento sets special_from_date to today itself when saving a special price, so always write it too (exact undo)
  if (write.special_price != null && !('special_from_date' in write)) write.special_from_date = target.special_from_date ?? null;
  return { write, notes };
}
/** Undo values of the price fields from the record (Magento raw values, null = value was missing) */
export function priceUndo(p: MRecord, keys: (keyof PriceWrite)[]): PriceWrite {
  const out: PriceWrite = {};
  for (const k of keys) (out as Record<string, unknown>)[k] = k === 'price' ? num(p.price) : k === 'special_price' ? num(attr(p, k)) : (attr(p, k) as string | null | undefined) ?? null;
  return out;
}
export const priceText = (s: Pick<PriceState, 'selling' | 'list'>, b?: PriceBasis | null) => `${money(s.selling) ?? '–'}${s.list != null ? ` (statt ${money(s.list)})` : ''}${b !== undefined && s.selling != null ? ` ${basisWord(b)}` : ''}`;

// ---- Media ----
/** Media ID in Lotse: product ID + gallery entry (Magento has no media library with its own IDs for product images) */
export const mediaId = (productId: number | string, entryId: number | string) => `mg-${productId}-${entryId}`;
export const parseMediaId = (id: string): { productId: string; entryId: number } | null => { const m = /^mg-(\d+)-(\d+)$/.exec(id.trim()); return m ? { productId: m[1], entryId: Number(m[2]) } : null; };
export const COVER_TYPES = ['image', 'small_image', 'thumbnail'] as const;
export const IMAGE_ROLES = ['image', 'small_image', 'thumbnail', 'swatch_image'] as const;
/** Cover image = gallery entry with role "image" (base image) */
export const coverEntry = (p: MProduct) => (p.media_gallery_entries ?? []).find(e => e.types?.includes('image')) ?? null;

// ---- URL key ----
/** Slug like a Magento URL key: lowercase, ä→ae, ö→oe, ü→ue, ß→ss, only a-z0-9 and hyphens */
export function urlKey(s: string): string {
  return s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-').slice(0, 120);
}

// ---- Visibility / status ----
export const VISIBILITY: Record<number, string> = { 1: 'nicht einzeln sichtbar', 2: 'Katalog', 3: 'Suche', 4: 'Katalog, Suche' };
export const VISIBILITY_IN: Record<string, number> = { none: 1, catalog: 2, search: 3, both: 4 };
export const isActive = (p: MRecord) => Number(p.status) === 1;

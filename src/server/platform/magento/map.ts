// Magento-Datensätze lesen und Lotse-Felder auf Magento abbilden (reine Funktionen, getestet in magento.test.ts).
// Wichtig: Magento kennt keinen „Streichpreis“-Wert. Es zeigt den regulären Preis (price) durchgestrichen, sobald ein
// Sonderpreis (special_price, optional mit special_from_date/special_to_date) aktiv und niedriger ist. Lotse-Semantik:
// price = was der Kunde zahlt, listPrice = durchgestrichener Preis. planPrice() übersetzt das in price/special_price.

/** Magento-JSON ist je Ressource dynamisch – bewusst lose typisiert */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MRecord = Record<string, any>;
export interface MAttr { attribute_code: string; value: unknown }
export interface MGalleryEntry { id: number; media_type?: string; label?: string | null; position?: number; disabled?: boolean; types?: string[]; file?: string }
export interface MProduct extends MRecord { id: number; sku: string; name?: string; price?: number; status?: number; visibility?: number; type_id?: string; custom_attributes?: MAttr[]; media_gallery_entries?: MGalleryEntry[]; extension_attributes?: MRecord }
export interface MCategory extends MRecord { id: number; parent_id?: number; name?: string; is_active?: boolean; level?: number; children_data?: MCategory[]; custom_attributes?: MAttr[] }

/** Attribute, die Magento als Feld des Datensatzes (nicht unter custom_attributes) führt */
const TOP_LEVEL = new Set(['name', 'price', 'status', 'visibility', 'weight', 'type_id', 'attribute_set_id', 'is_active', 'include_in_menu', 'position']);
export const isTopLevel = (code: string) => TOP_LEVEL.has(code);
export function attr(rec: MRecord | null | undefined, code: string): unknown {
  if (!rec) return undefined;
  if (TOP_LEVEL.has(code)) return rec[code];
  return (rec.custom_attributes as MAttr[] | undefined)?.find(a => a.attribute_code === code)?.value;
}
export const attrStr = (rec: MRecord | null | undefined, code: string): string | null => { const v = attr(rec, code); return v == null || v === '' ? null : String(v); };
const empty = (v: unknown) => v == null || v === '' || (Array.isArray(v) && !v.length);
/** Gleichheit von Attributwerten (Magento liefert Zahlen teils als String, leer = null) */
export const sameValue = (a: unknown, b: unknown) => (empty(a) && empty(b)) || (!empty(a) && !empty(b) && String(Array.isArray(a) ? a.join(',') : a) === String(Array.isArray(b) ? b.join(',') : b));
/** Schreib-Body eines Produkts/einer Kategorie: Felder oben, Rest als custom_attributes (null = Wert der Ebene entfernen → „Standardwert verwenden“) */
export function writeBody(values: Record<string, unknown>, top: Record<string, unknown> = {}): MRecord {
  const out: MRecord = { ...top }, ca: MAttr[] = [];
  for (const [k, v] of Object.entries(values)) { if (TOP_LEVEL.has(k)) out[k] = v; else ca.push({ attribute_code: k, value: v }); }
  if (ca.length) out.custom_attributes = ca;
  return out;
}

export const plain = (t: unknown) => String(t ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
export const money = (v: number | null | undefined, cur = 'EUR') => (v == null || !Number.isFinite(v) ? null : `${Number(v).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur === 'EUR' ? '€' : cur}`);
const num = (v: unknown) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
/** „2026-10-01 00:00:00“ → „2026-10-01“ */
export const day = (v: unknown) => (v == null || v === '' ? null : String(v).slice(0, 10));
export const isoDay = (d = new Date(), tz = 'Europe/Berlin') => new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
export const deDay = (d: string | null) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : '–');

// ---- Preise ----
/**
 * Preisbasis der Katalogpreise (tax/calculation/price_includes_tax). Magento-Standard ist netto, über REST/GraphQL nicht abfragbar,
 * darum Einstellung. Unbekannt = Lotse zeigt Preise mit Hinweis und ändert keine.
 */
export type PriceBasis = 'gross' | 'net';
export const parseBasis = (v: unknown): PriceBasis | null => { const s = String(v ?? '').trim().toLowerCase(); return s === 'gross' || s === 'brutto' ? 'gross' : s === 'net' || s === 'netto' ? 'net' : null; };
export const basisWord = (b: PriceBasis | null) => (b === 'gross' ? 'brutto' : b === 'net' ? 'netto' : 'brutto/netto unbekannt');
export const BASIS_MISSING = 'Preisbasis unbekannt: Erst in Lotse unter Einstellungen → Shop verbinden „Preise im Magento-Admin“ (brutto oder netto) festlegen, bis dahin ändert Lotse keine Preise';
export function needBasis(b: PriceBasis | null): PriceBasis { if (!b) throw new Error(BASIS_MISSING); return b; }
export interface PriceState { regular: number | null; special: number | null; from: string | null; to: string | null; active: boolean; selling: number | null; list: number | null }
/** Aktueller Preiszustand: Sonderpreis aktiv = gesetzt, kleiner als der reguläre Preis und heute im Zeitraum */
export function priceState(p: MRecord, today = isoDay()): PriceState {
  const regular = num(p.price), special = num(attr(p, 'special_price')), from = day(attr(p, 'special_from_date')), to = day(attr(p, 'special_to_date'));
  const active = special != null && regular != null && special < regular && (!from || from <= today) && (!to || to >= today);
  return { regular, special, from, to, active, selling: active ? special : regular, list: active ? regular : null };
}
export interface PriceWrite { price?: number; special_price?: number | null; special_from_date?: string | null; special_to_date?: string | null }
/**
 * Lotse-Preise (price = Verkaufspreis, listPrice = Streichpreis, Datumsgrenzen des Sonderpreises) → Magento-Werte.
 * undefined = unverändert, listPrice null = Streichpreis entfernen. Liefert nur Felder, die sich ändern, plus Hinweise.
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
  } else if (want.listPrice === null) { // Streichpreis ausdrücklich entfernen: Sonderpreis samt Zeitraum löschen
    if (want.from != null || want.to != null) throw new Error('Zeitraum gilt nur für einen Sonderpreis (listPrice angeben)');
    target.price = selling; target.special_price = null; target.special_from_date = null; target.special_to_date = null;
    if (s.special != null && !s.active) notes.push(`Bisheriger Sonderpreis ${money(s.special)} (derzeit nicht aktiv${s.from ? `, ab ${deDay(s.from)}` : ''}${s.to ? `, bis ${deDay(s.to)}` : ''}) wird entfernt`);
  } else { // nur der Preis: geplanter/abgelaufener Sonderpreis bleibt, wie er ist
    if (want.from != null || want.to != null) throw new Error('Zeitraum gilt nur für einen Sonderpreis (listPrice angeben)');
    target.price = selling;
    if (s.special != null) notes.push(`Vorhandener Sonderpreis ${money(s.special)}${s.from ? ` ab ${deDay(s.from)}` : ''}${s.to ? ` bis ${deDay(s.to)}` : ''} bleibt unverändert${s.special < selling ? ' und wird im Zeitraum unter diesem Preis angezeigt' : ''}`);
  }
  const cur: PriceWrite = { price: s.regular ?? undefined, special_price: s.special, special_from_date: s.from, special_to_date: s.to };
  const write: PriceWrite = {};
  for (const k of Object.keys(target) as (keyof PriceWrite)[]) if (!sameValue(target[k], cur[k])) (write as Record<string, unknown>)[k] = target[k];
  // Magento setzt special_from_date beim Speichern eines Sonderpreises selbst auf heute – darum immer mitschreiben (exaktes Rückgängig)
  if (write.special_price != null && !('special_from_date' in write)) write.special_from_date = target.special_from_date ?? null;
  return { write, notes };
}
/** Rückgängig-Werte der Preisfelder aus dem Datensatz (Magento-Rohwerte, null = Wert fehlte) */
export function priceUndo(p: MRecord, keys: (keyof PriceWrite)[]): PriceWrite {
  const out: PriceWrite = {};
  for (const k of keys) (out as Record<string, unknown>)[k] = k === 'price' ? num(p.price) : k === 'special_price' ? num(attr(p, k)) : (attr(p, k) as string | null | undefined) ?? null;
  return out;
}
export const priceText = (s: Pick<PriceState, 'selling' | 'list'>, b?: PriceBasis | null) => `${money(s.selling) ?? '–'}${s.list != null ? ` (statt ${money(s.list)})` : ''}${b !== undefined && s.selling != null ? ` ${basisWord(b)}` : ''}`;

// ---- Medien ----
/** Medien-ID in Lotse: Produkt-ID + Galerie-Eintrag (Magento hat keine Medienbibliothek mit eigenen IDs für Produktbilder) */
export const mediaId = (productId: number | string, entryId: number | string) => `mg-${productId}-${entryId}`;
export const parseMediaId = (id: string): { productId: string; entryId: number } | null => { const m = /^mg-(\d+)-(\d+)$/.exec(id.trim()); return m ? { productId: m[1], entryId: Number(m[2]) } : null; };
export const COVER_TYPES = ['image', 'small_image', 'thumbnail'] as const;
export const IMAGE_ROLES = ['image', 'small_image', 'thumbnail', 'swatch_image'] as const;
/** Titelbild = Galerie-Eintrag mit Rolle „image“ (Basisbild) */
export const coverEntry = (p: MProduct) => (p.media_gallery_entries ?? []).find(e => e.types?.includes('image')) ?? null;

// ---- URL-Schlüssel ----
/** Slug wie Magento-URL-Schlüssel: klein, ä→ae, ö→oe, ü→ue, ß→ss, nur a-z0-9 und Bindestriche */
export function urlKey(s: string): string {
  return s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-').slice(0, 120);
}

// ---- Sichtbarkeit / Status ----
export const VISIBILITY: Record<number, string> = { 1: 'nicht einzeln sichtbar', 2: 'Katalog', 3: 'Suche', 4: 'Katalog, Suche' };
export const VISIBILITY_IN: Record<string, number> = { none: 1, catalog: 2, search: 3, both: 4 };
export const isActive = (p: MRecord) => Number(p.status) === 1;

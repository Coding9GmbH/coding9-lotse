// OpenMage-Datensätze (Lotse_Connector-API) lesen und auf Lotse-Felder abbilden (reine Funktionen, getestet in openmage.test.ts).
// Die Preislogik ist dieselbe wie bei Magento 2 (price = regulär/durchgestrichen, special_price = Verkaufspreis mit Zeitraum):
// planPrice/priceState aus magento/map.ts werden über mrec() auf OpenMage-Datensätze angewendet.
import { attr, basisWord, day, deDay, isoDay, money, parseBasis, plain, planPrice, priceState, priceText, priceUndo, sameValue, urlKey, VISIBILITY, VISIBILITY_IN, type MRecord, type PriceBasis, type PriceState, type PriceWrite } from '../magento/map';

export { basisWord, day, deDay, isoDay, money, parseBasis, plain, planPrice, priceState, priceText, priceUndo, sameValue, urlKey, VISIBILITY, VISIBILITY_IN };
export type { PriceBasis, PriceState, PriceWrite };

/** API-JSON ist je Ressource dynamisch – bewusst lose typisiert */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OmRecord = Record<string, any>;
/**
 * OpenMage hängt an jeden Seitentitel das Theme-Suffix (design/head/title_suffix, z. B. „ | Haus Holm“) bzw. -Präfix an. Schreibt die KI die
 * Marke selbst ans Ende eines Meta-Titles oder Seitentitels, stünde sie doppelt im Browser-Tab: hier wird ein solches Ende/Anfang entfernt.
 */
export function stripTitleAffixes(title: string, view?: { title_prefix?: string | null; title_suffix?: string | null } | null): string {
  let t = title.trim();
  const SEP = '|–—\\-·:', trimEnd = (s: string) => s.replace(new RegExp(`[\\s${SEP}]+$`), ''), trimStart = (s: string) => s.replace(new RegExp(`^[\\s${SEP}]+`), '');
  const endsWith = (s: string, tail: string) => s.toLowerCase().endsWith(tail.toLowerCase()), startsWith = (s: string, head: string) => s.toLowerCase().startsWith(head.toLowerCase());
  // Suffix wie konfiguriert („| Haus Holm“) oder nur der Name nach einem Trenner („Vase – Haus Holm“); „Vase bei Haus Holm“ bleibt
  const suffix = String(view?.title_suffix ?? '').trim(), sufName = trimStart(suffix).trim();
  if (sufName) {
    const cut = endsWith(t, suffix) ? t.slice(0, -suffix.length) : endsWith(t, sufName) && new RegExp(`[${SEP}]\\s*$`).test(t.slice(0, -sufName.length)) ? t.slice(0, -sufName.length) : null;
    if (cut != null && trimEnd(cut).trim()) t = trimEnd(cut).trim();
  }
  const prefix = String(view?.title_prefix ?? '').trim(), preName = trimEnd(prefix).trim();
  if (preName) {
    const cut = startsWith(t, prefix) ? t.slice(prefix.length) : startsWith(t, preName) && new RegExp(`^\\s*[${SEP}]`).test(t.slice(preName.length)) ? t.slice(preName.length) : null;
    if (cut != null && trimStart(cut).trim()) t = trimStart(cut).trim();
  }
  return t;
}
export interface OmImage { id: number; file: string; url: string; label: string; position: number; disabled: boolean; types: string[]; label_use_default?: boolean; position_use_default?: boolean; has_store_values?: boolean }
export interface OmStock { item_id?: number | null; qty: number; is_in_stock: boolean; manage_stock?: boolean; use_config_manage_stock?: boolean }
/** Listeneintrag (GET /v1/products) bzw. Detail (GET /v1/products/{sku}); Detail hat attributes, store_overrides, images, stock, categories */
export interface OmProduct extends OmRecord {
  id: number; sku: string; type_id: string; attribute_set_id?: number; name?: string | null; status?: number; visibility?: number;
  price?: number | null; special_price?: number | null; special_from_date?: string | null; special_to_date?: string | null; weight?: number | null;
  url_key?: string | null; url_path?: string | null; url?: string | null; image?: string | null; qty?: number | null; is_in_stock?: boolean | null;
  category_ids?: number[]; website_ids?: number[];
  attributes?: Record<string, unknown>; attribute_labels?: Record<string, unknown>; store_overrides?: string[]; stock?: OmStock;
  categories?: { id: number; position: number; name?: string | null; path?: string | null }[]; images?: OmImage[];
  configurable?: { attributes: { id: number; attribute_id: number; code: string; label: string; position: number; options: { value: unknown; label: string }[] }[]; children: { id: number; sku: string; name: string | null; status: number; price: number | null; attributes: Record<string, number | null>; qty: number; is_in_stock: boolean }[] };
  parent_ids?: number[];
  _write?: { updated?: string[]; reverted?: string[]; reindexed?: string[]; rewrites_added?: number[] };
}
export interface OmCategory extends OmRecord {
  id: number; parent_id?: number; path?: string; level?: number; position?: number; name?: string | null; is_active?: boolean; include_in_menu?: boolean; is_anchor?: boolean;
  url_key?: string | null; url_path?: string | null; display_mode?: string | null; landing_page?: number | null; product_count?: number; children_count?: number; children?: OmCategory[];
  description?: string | null; meta_title?: string | null; meta_keywords?: string | null; meta_description?: string | null; url?: string | null;
  landing_page_block?: { id: number; identifier: string; title: string; is_active: boolean } | null; attributes?: Record<string, unknown>; store_overrides?: string[]; child_ids?: number[];
}

/** Attributwert eines Produkts/einer Kategorie: Detail unter attributes, Liste (und Kernfelder) direkt */
export function omAttr(rec: OmRecord | null | undefined, code: string): unknown {
  if (!rec) return undefined;
  if (rec.attributes && typeof rec.attributes === 'object' && code in rec.attributes) return rec.attributes[code];
  return rec[code];
}
export const omStr = (rec: OmRecord | null | undefined, code: string): string | null => { const v = omAttr(rec, code); return v == null || v === '' ? null : String(v); };
/** Hat die Store-View einen eigenen Wert für das Attribut? (nur im Store-Scope gelesen aussagekräftig) */
export const hasOverride = (rec: OmRecord | null | undefined, code: string) => Array.isArray(rec?.store_overrides) && rec!.store_overrides.includes(code);

const PRICE_CODES = ['special_price', 'special_from_date', 'special_to_date', 'description', 'short_description', 'meta_title', 'meta_description', 'meta_keyword', 'url_key', 'tax_class_id', 'display_mode', 'landing_page', 'meta_keywords'];
/**
 * OpenMage-Datensatz → Magento-2-Form (Kernfelder oben, Rest als custom_attributes, Galerie als media_gallery_entries), damit die
 * reinen Hilfen aus magento/map.ts (priceState, planPrice, priceUndo) und die Prüfregeln (auditRecords, productHits) wiederverwendbar sind.
 */
export function mrec(p: OmRecord): MRecord {
  const ca: { attribute_code: string; value: unknown }[] = [];
  const src = (p.attributes && typeof p.attributes === 'object' ? p.attributes : {}) as Record<string, unknown>;
  for (const code of new Set([...PRICE_CODES, ...Object.keys(src)])) { const v = omAttr(p, code); if (v !== undefined && !['name', 'price', 'status', 'visibility', 'weight', 'sku'].includes(code)) ca.push({ attribute_code: code, value: v }); }
  return { id: p.id, sku: p.sku, type_id: p.type_id, name: p.name, price: p.price, status: p.status, visibility: p.visibility, weight: p.weight, is_active: p.is_active, custom_attributes: ca,
    media_gallery_entries: ((p.images ?? []) as OmImage[]).map(e => ({ id: e.id, label: e.label, position: e.position, disabled: e.disabled, types: e.types, file: e.file })) };
}
export const priceOf = (p: OmRecord, today?: string): PriceState => priceState(mrec(p), today);
export const attrM = attr;

export const isActive = (p: OmRecord) => Number(p.status) === 1;
export const isVisible = (p: OmRecord) => Number(p.visibility) !== 1;
export const FROM_KIDS = new Set(['configurable', 'bundle', 'grouped']);
export const SIMPLE_TYPES = new Set(['simple', 'virtual', 'downloadable']);
export const productLabel = (p: OmRecord) => `${plain(p.name) || p.sku} (${p.sku})`;

// ---- Medien ----
/** Medien-ID in Lotse: Produkt-ID + Galerie-Eintrag (value_id); OpenMage hat keine Medienbibliothek für Produktbilder */
export const mediaId = (productId: number | string, imageId: number | string) => `om-${productId}-${imageId}`;
export const parseMediaId = (id: string): { productId: string; imageId: number } | null => { const m = /^om-(\d+)-(\d+)$/.exec(String(id ?? '').trim()); return m ? { productId: m[1], imageId: Number(m[2]) } : null; };
export const COVER_TYPES = ['image', 'small_image', 'thumbnail'] as const;
export const coverImage = (p: OmProduct) => (p.images ?? []).find(e => e.types?.includes('image')) ?? null;
export const fileName = (e: Pick<OmImage, 'file' | 'id'>) => String(e.file ?? '').split('/').pop() || `Bild ${e.id}`;

// ---- URLs ----
/** Produkt-URL in einer Store-View: eigene url_path (Kategoriepfad) nur, wenn vom Modul geliefert, sonst url_key + Suffix */
export const productPath = (p: OmRecord, suffix = '.html') => { const k = omStr(p, 'url_key'); return k ? `${k}${suffix}` : null; };
export const categoryPath = (c: OmRecord, suffix = '.html') => { const up = omStr(c, 'url_path'); if (up) return /\.[a-z0-9]+$/i.test(up) ? up : `${up}${suffix}`; const k = omStr(c, 'url_key'); return k ? `${k}${suffix}` : null; };
/** Ziel eines URL-Rewrites: catalog/product/view/id/1[/category/3], catalog/category/view/id/3 */
export function parseTarget(target: string | null | undefined): { type: 'PRODUCT' | 'CATEGORY'; id: number; categoryId?: number } | null {
  const t = String(target ?? '');
  let m = /^catalog\/product\/view\/id\/(\d+)(?:\/category\/(\d+))?/.exec(t);
  if (m) return { type: 'PRODUCT', id: Number(m[1]), ...(m[2] ? { categoryId: Number(m[2]) } : {}) };
  m = /^catalog\/category\/view\/id\/(\d+)/.exec(t);
  if (m) return { type: 'CATEGORY', id: Number(m[1]) };
  return null;
}
/** Identifier einer CMS-Seite (Buchstaben, Ziffern, - _ . /) aus einem Pfad */
export function cmsIdentifier(url: string): string {
  const raw = String(url ?? '').trim().replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, '');
  const html = /\.html?$/i.test(raw);
  const segs = raw.replace(/\.html?$/i, '').split('/').map(s => urlKey(s)).filter(Boolean);
  if (!segs.length) throw new Error('url fehlt (Pfad der Landingpage, z. B. "ratgeber/vasen")');
  const id = segs.join('/') + (html ? '.html' : '');
  if (id.length > 100) throw new Error('url ist zu lang (max. 100 Zeichen)');
  return id;
}

/** Gleichheit eines Attributwerts in zwei Scopes (Zahlen als String, leer = null) */
export const same = (a: unknown, b: unknown) => sameValue(a, b) || (typeof a === 'boolean' && sameValue(a ? 1 : 0, b)) || (typeof b === 'boolean' && sameValue(a, b ? 1 : 0));
/** Leerwert für den globalen Scope (null ist dort nicht erlaubt) */
export const globalEmpty = (v: unknown) => (v === null || v === undefined ? '' : v);
/** Display-Modi einer Kategorie */
export const DISPLAY_MODE: Record<string, string> = { PRODUCTS: 'nur Produkte', PAGE: 'nur statischer Block', PRODUCTS_AND_PAGE: 'statischer Block und Produkte' };

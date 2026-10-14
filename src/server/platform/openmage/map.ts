// Read OpenMage records (Lotse_Connector API) and map them to Lotse fields (pure functions, tested in openmage.test.ts).
// The price logic is the same as for Magento 2 (price = regular/strikethrough, special_price = selling price with period):
// planPrice/priceState from magento/map.ts are applied to OpenMage records via mrec().
import { basisWord, day, deDay, isoDay, money, parseBasis, plain, planPrice, priceState, priceText, priceUndo, sameValue, urlKey, VISIBILITY, VISIBILITY_IN, type MRecord, type PriceBasis, type PriceState, type PriceWrite } from '../magento/map';

export { basisWord, day, deDay, isoDay, money, parseBasis, plain, planPrice, priceState, priceText, priceUndo, sameValue, urlKey, VISIBILITY, VISIBILITY_IN };
export type { PriceBasis, PriceState, PriceWrite };

/** API JSON is dynamic per resource, deliberately loosely typed */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OmRecord = Record<string, any>;
/**
 * OpenMage appends the theme suffix (design/head/title_suffix, e.g. " | Haus Holm") or prefix to every page title. If the AI writes the
 * brand itself at the end of a meta title or page title, it would appear twice in the browser tab: such an end/start is removed here.
 */
export function stripTitleAffixes(title: string, view?: { title_prefix?: string | null; title_suffix?: string | null } | null): string {
  let t = title.trim();
  const SEP = '|–—\\-·:', trimEnd = (s: string) => s.replace(new RegExp(`[\\s${SEP}]+$`), ''), trimStart = (s: string) => s.replace(new RegExp(`^[\\s${SEP}]+`), '');
  const endsWith = (s: string, tail: string) => s.toLowerCase().endsWith(tail.toLowerCase()), startsWith = (s: string, head: string) => s.toLowerCase().startsWith(head.toLowerCase());
  // suffix as configured ("| Haus Holm") or just the name after a separator ("Vase – Haus Holm"); "Vase bei Haus Holm" stays
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
/** List entry (GET /v1/products) or detail (GET /v1/products/{sku}); detail has attributes, store_overrides, images, stock, categories */
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

/** Attribute value of a product/category: detail under attributes, list (and core fields) directly */
export function omAttr(rec: OmRecord | null | undefined, code: string): unknown {
  if (!rec) return undefined;
  if (rec.attributes && typeof rec.attributes === 'object' && code in rec.attributes) return rec.attributes[code];
  return rec[code];
}
export const omStr = (rec: OmRecord | null | undefined, code: string): string | null => { const v = omAttr(rec, code); return v == null || v === '' ? null : String(v); };
/** Does the store view have its own value for the attribute? (only meaningful when read in store scope) */
export const hasOverride = (rec: OmRecord | null | undefined, code: string) => Array.isArray(rec?.store_overrides) && rec!.store_overrides.includes(code);

const PRICE_CODES = ['special_price', 'special_from_date', 'special_to_date', 'description', 'short_description', 'meta_title', 'meta_description', 'meta_keyword', 'url_key', 'tax_class_id', 'display_mode', 'landing_page', 'meta_keywords'];
/**
 * OpenMage record → Magento 2 shape (core fields at the top, the rest as custom_attributes, gallery as media_gallery_entries), so the
 * pure helpers from magento/map.ts (priceState, planPrice, priceUndo) and the check rules (auditRecords, productHits) can be reused.
 */
export function mrec(p: OmRecord): MRecord {
  const ca: { attribute_code: string; value: unknown }[] = [];
  const src = (p.attributes && typeof p.attributes === 'object' ? p.attributes : {}) as Record<string, unknown>;
  for (const code of new Set([...PRICE_CODES, ...Object.keys(src)])) { const v = omAttr(p, code); if (v !== undefined && !['name', 'price', 'status', 'visibility', 'weight', 'sku'].includes(code)) ca.push({ attribute_code: code, value: v }); }
  return { id: p.id, sku: p.sku, type_id: p.type_id, name: p.name, price: p.price, status: p.status, visibility: p.visibility, weight: p.weight, is_active: p.is_active, custom_attributes: ca,
    media_gallery_entries: ((p.images ?? []) as OmImage[]).map(e => ({ id: e.id, label: e.label, position: e.position, disabled: e.disabled, types: e.types, file: e.file })) };
}
export const priceOf = (p: OmRecord, today?: string): PriceState => priceState(mrec(p), today);

export const isActive = (p: OmRecord) => Number(p.status) === 1;
export const isVisible = (p: OmRecord) => Number(p.visibility) !== 1;
export const FROM_KIDS = new Set(['configurable', 'bundle', 'grouped']);
export const SIMPLE_TYPES = new Set(['simple', 'virtual', 'downloadable']);
export const productLabel = (p: OmRecord) => `${plain(p.name) || p.sku} (${p.sku})`;

// ---- Media ----
/** Media ID in Lotse: product ID + gallery entry (value_id); OpenMage has no media library for product images */
export const mediaId = (productId: number | string, imageId: number | string) => `om-${productId}-${imageId}`;
export const parseMediaId = (id: string): { productId: string; imageId: number } | null => { const m = /^om-(\d+)-(\d+)$/.exec(String(id ?? '').trim()); return m ? { productId: m[1], imageId: Number(m[2]) } : null; };
export const COVER_TYPES = ['image', 'small_image', 'thumbnail'] as const;
export const coverImage = (p: OmProduct) => (p.images ?? []).find(e => e.types?.includes('image')) ?? null;
export const fileName = (e: Pick<OmImage, 'file' | 'id'>) => String(e.file ?? '').split('/').pop() || `Bild ${e.id}`;

// ---- URLs ----
/** Product URL in a store view: own url_path (category path) only if provided by the module, otherwise url_key + suffix */
export const productPath = (p: OmRecord, suffix = '.html') => { const k = omStr(p, 'url_key'); return k ? `${k}${suffix}` : null; };
export const categoryPath = (c: OmRecord, suffix = '.html') => { const up = omStr(c, 'url_path'); if (up) return /\.[a-z0-9]+$/i.test(up) ? up : `${up}${suffix}`; const k = omStr(c, 'url_key'); return k ? `${k}${suffix}` : null; };
/** Target of a URL rewrite: catalog/product/view/id/1[/category/3], catalog/category/view/id/3 */
export function parseTarget(target: string | null | undefined): { type: 'PRODUCT' | 'CATEGORY'; id: number; categoryId?: number } | null {
  const t = String(target ?? '');
  let m = /^catalog\/product\/view\/id\/(\d+)(?:\/category\/(\d+))?/.exec(t);
  if (m) return { type: 'PRODUCT', id: Number(m[1]), ...(m[2] ? { categoryId: Number(m[2]) } : {}) };
  m = /^catalog\/category\/view\/id\/(\d+)/.exec(t);
  if (m) return { type: 'CATEGORY', id: Number(m[1]) };
  return null;
}
/** Identifier of a CMS page (letters, digits, - _ . /) from a path */
export function cmsIdentifier(url: string): string {
  const raw = String(url ?? '').trim().replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, '');
  const html = /\.html?$/i.test(raw);
  const segs = raw.replace(/\.html?$/i, '').split('/').map(s => urlKey(s)).filter(Boolean);
  if (!segs.length) throw new Error('url fehlt (Pfad der Landingpage, z. B. "ratgeber/vasen")');
  const id = segs.join('/') + (html ? '.html' : '');
  if (id.length > 100) throw new Error('url ist zu lang (max. 100 Zeichen)');
  return id;
}

/** Equality of an attribute value in two scopes (numbers as string, empty = null) */
export const same = (a: unknown, b: unknown) => sameValue(a, b) || (typeof a === 'boolean' && sameValue(a ? 1 : 0, b)) || (typeof b === 'boolean' && sameValue(a, b ? 1 : 0));
/** Empty value for the global scope (null is not allowed there) */
export const globalEmpty = (v: unknown) => (v === null || v === undefined ? '' : v);
/** Display modes of a category */
export const DISPLAY_MODE: Record<string, string> = { PRODUCTS: 'nur Produkte', PAGE: 'nur statischer Block', PRODUCTS_AND_PAGE: 'statischer Block und Produkte' };

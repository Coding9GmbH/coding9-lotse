import 'server-only';
// Shopify: fixed GraphQL queries and conversion into Lotse data (short IDs, formatted prices). The same functions read
// for the AI via the protected reader (reader.query) and in the executor via the privileged client (client.gql).
import { noteMedia } from '../../media';
import { shortId, toGid, type Json } from './client';

export type Q = <T = Json>(doc: string, vars?: Json) => Promise<T>;

// ---- Formatting ----
export const toNum = (v: unknown): number | null => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
export function fmtMoney(v: unknown, currency = 'EUR'): string | null {
  const n = toNum(v); if (n == null) return null;
  try { return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(n).replace(/\u00a0/g, ' '); } catch { return `${n.toFixed(2)} ${currency}`; }
}
/** Decimal places of a currency (EUR 2, JPY 0, KWD 3); unknown = 2 */
export function currencyDigits(currency?: string): number {
  if (!currency) return 2;
  try { return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2; } catch { return 2; }
}
/** Amount as Shopify money string ("49.00", for KWD "1.250", for JPY "1000"), rounded to the currency's decimal places (without currency 2) */
export const money = (n: number, currency?: string) => { const d = currencyDigits(currency), f = 10 ** d; return (Math.round(n * f) / f).toFixed(d); };
/** Write back a money value from Shopify unchanged (undo: exact, without rounding) */
export const moneyRaw = (v: unknown): string | null => (v == null ? null : String(v));
export const stripHtml = (t: unknown) => String(t ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
/** Defuse free text for Shopify search syntax (don't pass the AI's filter syntax through) */
export const searchText = (t: string) => t.replace(/[\\"():*]/g, ' ').replace(/\b(AND|OR|NOT)\b/g, ' ').replace(/(^|\s)-/g, '$1').replace(/\s+/g, ' ').trim();
const quote = (v: string) => `"${v.replace(/[\\"]/g, '')}"`;
/** Search filter field:"value" */
export const qField = (field: string, value: string | number) => `${field}:${typeof value === 'number' ? value : quote(value)}`;

// ---- Selections ----
const IMG = 'image { url altText width height }';
export const PRODUCT_LIST = `id title handle status vendor productType tags totalInventory tracksInventory onlineStoreUrl hasOnlyDefaultVariant
  priceRangeV2 { minVariantPrice { amount currencyCode } maxVariantPrice { amount } }
  compareAtPriceRange { maxVariantCompareAtPrice { amount } }
  featuredMedia { id ... on MediaImage { ${IMG} } }
  variantsCount { count }
  variants(first: 1) { nodes { sku barcode } }
  seo { title description }
  descriptionHtml`;
export const VARIANT = 'id title sku barcode price compareAtPrice inventoryQuantity position selectedOptions { name value }';
export const PRODUCT_CORE = `id title handle status vendor productType tags descriptionHtml onlineStoreUrl totalInventory tracksInventory hasOnlyDefaultVariant
  seo { title description }
  options { id name values }
  variants(first: 100) { nodes { ${VARIANT} } pageInfo { hasNextPage endCursor } }
  faq: metafield(namespace: "lotse", key: "faq") { id type value }`;
export const PRODUCT_DETAIL = `${PRODUCT_CORE}
  featuredMedia { id }
  media(first: 50) { nodes { id alt mediaContentType status ... on MediaImage { ${IMG} } } }
  collections(first: 25) { nodes { id title handle } }`;
export const COLLECTION_CORE = `id title handle descriptionHtml sortOrder templateSuffix updatedAt onlineStoreUrl
  seo { title description }
  ruleSet { appliedDisjunctively rules { column relation condition } }
  image { url altText }
  productsCount { count }`;

// ---- Shop ----
export interface ShopInfo { name: string; currency: string; primaryUrl: string; myshopifyDomain: string; taxesIncluded: boolean; timezone: string }
export async function shopInfo(q: Q): Promise<ShopInfo> {
  const r = await q<{ shop: Json }>('query ShopInfo { shop { name currencyCode myshopifyDomain url primaryDomain { url host } taxesIncluded ianaTimezone } }');
  const s = r.shop;
  return { name: s.name, currency: s.currencyCode ?? 'EUR', primaryUrl: String(s.primaryDomain?.url ?? s.url ?? '').replace(/\/+$/, ''), myshopifyDomain: s.myshopifyDomain, taxesIncluded: !!s.taxesIncluded, timezone: s.ianaTimezone };
}

// ---- Products ----
const imgOf = (m: Json | null | undefined) => m?.image?.url as string | undefined;
export function productBrief(p: Json, currency = 'EUR') {
  const min = toNum(p.priceRangeV2?.minVariantPrice?.amount), max = toNum(p.priceRangeV2?.maxVariantPrice?.amount);
  const img = p.featuredMedia?.image;
  return {
    id: shortId(p.id), name: p.title, number: p.variants?.nodes?.[0]?.sku ?? undefined, handle: p.handle,
    price: min == null ? null : `${max != null && max > min ? 'ab ' : ''}${fmtMoney(min, currency)}`,
    manufacturer: p.vendor || undefined, status: p.status, image: img?.url,
    ...(img && noteMedia({ url: img.url, alt: img.altText }) ? { imageAiGenerated: true } : {}),
  };
}

/** Products by ID (short or GID) via nodes; choose chunk so the requested cost stays ≤ 1000 (PRODUCT_CORE ≈ 210 per product) */
export async function productsByIds(q: Q, ids: string[], sel = PRODUCT_CORE, chunk = 4): Promise<Json[]> {
  const gids = [...new Set(ids.map(i => toGid('Product', i)))], out: Json[] = [];
  for (let i = 0; i < gids.length; i += chunk) {
    const r = await q<{ nodes: (Json | null)[] }>(`query ProductsByIds($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { ${sel} } } }`, { ids: gids.slice(i, i + chunk) });
    out.push(...r.nodes.filter((n): n is Json => !!n?.id));
  }
  return out;
}
/** all variants of a product (load more beyond 100) */
export async function allVariants(q: Q, p: Json): Promise<Json[]> {
  const list: Json[] = [...(p.variants?.nodes ?? [])];
  let page = p.variants?.pageInfo;
  while (page?.hasNextPage) {
    const r = await q<{ product: Json }>(`query MoreVariants($id: ID!, $after: String) { product(id: $id) { variants(first: 100, after: $after) { nodes { ${VARIANT} } pageInfo { hasNextPage endCursor } } } }`, { id: p.id, after: page.endCursor });
    list.push(...r.product.variants.nodes); page = r.product.variants.pageInfo;
  }
  return list;
}

export interface ProductFilter { term?: string; collectionId?: string; vendor?: string; productType?: string; tag?: string; status?: string; minPrice?: number; maxPrice?: number; maxStock?: number; minStock?: number; active?: boolean; sku?: string; priceReduced?: boolean }
/** Filter → Shopify search syntax (products(query:)) */
export function productQuery(f: ProductFilter): string {
  const parts: string[] = [];
  if (f.term) { const t = searchText(f.term); if (t) parts.push(t); }
  if (f.collectionId) parts.push(`collection_id:${shortId(toGid('Collection', f.collectionId))}`);
  if (f.vendor) parts.push(qField('vendor', f.vendor));
  if (f.productType) parts.push(qField('product_type', f.productType));
  if (f.tag) parts.push(qField('tag', f.tag));
  if (f.sku) parts.push(qField('sku', f.sku));
  if (f.status) parts.push(`status:${f.status.toLowerCase().replace(/[^a-z,]/g, '')}`);
  else if (f.active != null) parts.push(f.active ? 'status:active' : 'status:draft,archived');
  if (f.minPrice != null) parts.push(`price:>=${Number(f.minPrice)}`);
  if (f.maxPrice != null) parts.push(`price:<=${Number(f.maxPrice)}`);
  if (f.maxStock != null) parts.push(`inventory_total:<=${Math.floor(Number(f.maxStock))}`);
  if (f.minStock != null) parts.push(`inventory_total:>=${Math.floor(Number(f.minStock))}`);
  if (f.priceReduced) parts.push('is_price_reduced:true');
  return parts.join(' AND ');
}
export async function searchProducts(q: Q, query: string, o: { first?: number; after?: string | null; sel?: string; sortKey?: string } = {}): Promise<{ nodes: Json[]; pageInfo: Json }> {
  const r = await q<{ products: Json }>(`query SearchProducts($first: Int!, $after: String, $query: String) { products(first: $first, after: $after, query: $query, sortKey: ${o.sortKey ?? 'TITLE'}) { nodes { ${o.sel ?? PRODUCT_LIST} } pageInfo { hasNextPage endCursor } } }`,
    { first: Math.min(250, Math.max(1, o.first ?? 20)), after: o.after ?? null, query: query || null });
  return r.products as { nodes: Json[]; pageInfo: Json };
}
/** IDs of a root field (products, collections, pages, codeDiscountNodes) for a search filter, e.g. title: undo for create steps with unclear outcome (runCreating) */
export async function idsWhere(q: Q, root: string, query: string, first = 25): Promise<string[]> {
  const r = await q<Json>(`query IdsWhere($first: Int!, $query: String) { ${root}(first: $first, query: $query) { nodes { id } } }`, { first, query });
  return ((r[root]?.nodes ?? []) as Json[]).map(n => n.id);
}
export async function countProducts(q: Q, query: string): Promise<{ count: number; exact: boolean }> {
  const r = await q<{ productsCount: Json | null }>('query CountProducts($query: String) { productsCount(query: $query, limit: 10000) { count precision } }', { query: query || null });
  return { count: r.productsCount?.count ?? 0, exact: r.productsCount?.precision !== 'AT_LEAST' };
}
/** Cursor after offset records (pages through IDs only) */
export async function cursorAt(q: Q, query: string, offset: number, sortKey = 'TITLE'): Promise<string | null> {
  let after: string | null = null, left = Math.min(offset, 10_000);
  while (left > 0) {
    const r: { products: Json } = await q(`query Skip($first: Int!, $after: String, $query: String) { products(first: $first, after: $after, query: $query, sortKey: ${sortKey}) { pageInfo { hasNextPage endCursor } } }`, { first: Math.min(250, left), after, query: query || null });
    after = r.products.pageInfo.endCursor; left -= Math.min(250, left);
    if (!r.products.pageInfo.hasNextPage) return after;
  }
  return after;
}

// ---- Collections (= categories in Lotse) ----
export const collectionKind = (c: Json) => (c.ruleSet ? 'smart' : 'manual');
export function collectionBrief(c: Json) {
  return { id: shortId(c.id), name: c.title, handle: c.handle, type: collectionKind(c), products: c.productsCount?.count ?? null, description: stripHtml(c.descriptionHtml).slice(0, 200), metaTitle: c.seo?.title ?? null, metaDescription: c.seo?.description ?? null };
}
export async function collectionsByIds(q: Q, ids: string[], sel = COLLECTION_CORE): Promise<Json[]> {
  const gids = [...new Set(ids.map(i => toGid('Collection', i)))], out: Json[] = [];
  for (let i = 0; i < gids.length; i += 25) {
    const r = await q<{ nodes: (Json | null)[] }>(`query CollectionsByIds($ids: [ID!]!) { nodes(ids: $ids) { ... on Collection { ${sel} } } }`, { ids: gids.slice(i, i + 25) });
    out.push(...r.nodes.filter((n): n is Json => !!n?.id));
  }
  return out;
}
export async function searchCollections(q: Q, term: string | undefined, first = 50, after: string | null = null): Promise<{ nodes: Json[]; pageInfo: Json }> {
  const r = await q<{ collections: Json }>(`query SearchCollections($first: Int!, $after: String, $query: String) { collections(first: $first, after: $after, query: $query, sortKey: TITLE) { nodes { ${COLLECTION_CORE} } pageInfo { hasNextPage endCursor } } }`,
    { first: Math.min(100, first), after, query: term ? searchText(term) || null : null });
  return r.collections as { nodes: Json[]; pageInfo: Json };
}

// ---- Media ----
export function mediaRow(m: Json) {
  const url = imgOf(m), alt = m.image?.altText || m.alt || null;
  return { mediaId: shortId(m.id), url, alt, ...(url && noteMedia({ url, alt }) ? { aiGenerated: true } : {}) };
}
export async function mediaByIds(q: Q, ids: string[]): Promise<Json[]> {
  const gids = [...new Set(ids.map(i => toGid('MediaImage', i)))], out: Json[] = [];
  for (let i = 0; i < gids.length; i += 50) {
    const r = await q<{ nodes: (Json | null)[] }>(`query MediaByIds($ids: [ID!]!) { nodes(ids: $ids) { ... on MediaImage { id alt status ${IMG} } } }`, { ids: gids.slice(i, i + 50) });
    out.push(...r.nodes.filter((n): n is Json => !!n?.id));
  }
  return out;
}

// ---- Pages ----
export async function pagesByIds(q: Q, ids: string[]): Promise<Json[]> {
  const gids = [...new Set(ids.map(i => toGid('Page', i)))];
  if (!gids.length) return [];
  const r = await q<{ nodes: (Json | null)[] }>(`query PagesByIds($ids: [ID!]!) { nodes(ids: $ids) { ... on Page { id title handle body isPublished
    metaTitle: metafield(namespace: "global", key: "title_tag") { value } metaDescription: metafield(namespace: "global", key: "description_tag") { value } } } }`, { ids: gids });
  return r.nodes.filter((n): n is Json => !!n?.id);
}

/** Variant, short form for the AI */
export const variantRow = (v: Json, currency = 'EUR') => ({
  id: shortId(v.id), title: v.title, options: Object.fromEntries((v.selectedOptions ?? []).map((o: Json) => [o.name, o.value])), sku: v.sku ?? null, barcode: v.barcode ?? null,
  price: toNum(v.price), priceText: fmtMoney(v.price, currency), compareAtPrice: toNum(v.compareAtPrice), stock: v.inventoryQuantity ?? null,
});

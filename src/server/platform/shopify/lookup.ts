import 'server-only';
// Shopify: plattform-neutrale Lesefunktionen (ShopLookup) über den geschützten Lese-Client.
// Storefront-URLs: /products/<handle>, /collections/<handle>[/products/<handle>], /pages/<handle>, optional mit Sprachpräfix (/en/…).
import type { PageRef } from '../../features/gsc-map';
import type { LinkKind } from '../../seo-links';
import type { ShopLookup } from '../types';
import { shortId, toGid, type Json } from './client';
import { collectionsByIds, mediaByIds, pagesByIds, productsByIds, qField, shopInfo, type Q } from './data';
import type { ShopifyReader } from './reader';

const dec = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
const LOCALE = /^[a-z]{2}(-[a-z]{2,4})?$/i;
const RESERVED = new Set(['products', 'collections', 'pages', 'blogs', 'cart', 'search', 'account', 'cdn']);

/** Seiten-URL → { kind, handle } (Sprachpräfix wird übersprungen); null = keine Shop-Entität */
export function parseShopPath(url: string): { kind: LinkKind | 'home'; handle?: string } | null {
  let segs: string[];
  try { segs = new URL(url).pathname.split('/').filter(Boolean).map(dec); } catch { return null; }
  if (segs.length && LOCALE.test(segs[0]) && !RESERVED.has(segs[0])) segs = segs.slice(1);
  if (!segs.length) return { kind: 'home' };
  if (segs[0] === 'products' && segs[1]) return { kind: 'product', handle: segs[1] };
  if (segs[0] === 'collections' && segs[2] === 'products' && segs[3]) return { kind: 'product', handle: segs[3] };
  if (segs[0] === 'collections' && segs[1] && segs[1] !== 'all') return { kind: 'category', handle: segs[1] };
  if (segs[0] === 'pages' && segs[1]) return { kind: 'landing', handle: segs[1] };
  return null;
}

const ROOT: Record<LinkKind, string> = { product: 'products', category: 'collections', landing: 'pages' };
const SEL: Record<LinkKind, string> = {
  product: 'id title handle status seo { title description } variants(first: 1) { nodes { sku } }',
  category: 'id title handle seo { title description }',
  landing: 'id title handle isPublished metaTitle: metafield(namespace: "global", key: "title_tag") { value } metaDescription: metafield(namespace: "global", key: "description_tag") { value }',
};
/** Datensätze per Handle (bis 50 je Abfrage) */
async function byHandles(q: Q, kind: LinkKind, handles: string[]): Promise<Map<string, Json>> {
  const out = new Map<string, Json>();
  for (let i = 0; i < handles.length; i += 50) {
    const chunk = handles.slice(i, i + 50);
    const r = await q<Json>(`query ByHandle($first: Int!, $query: String) { ${ROOT[kind]}(first: $first, query: $query) { nodes { ${SEL[kind]} } } }`, { first: chunk.length, query: chunk.map(h => qField('handle', h)).join(' OR ') });
    for (const n of r[ROOT[kind]].nodes) out.set(String(n.handle).toLowerCase(), n);
  }
  return out;
}
const metas = (kind: LinkKind, e: Json) => (kind === 'landing' ? { metaTitle: e.metaTitle?.value ?? null, metaDescription: e.metaDescription?.value ?? null } : { metaTitle: e.seo?.title ?? null, metaDescription: e.seo?.description ?? null });

export function shopifyLookup(ro: ShopifyReader): ShopLookup {
  const q: Q = (d, v) => ro.query(d, v);
  const base = () => ro.memo('shop', () => shopInfo(q)).then(s => s.primaryUrl);
  return {
    async findProducts({ ids = [], numbers = [] }) {
      const out: { id: string; number?: string; name?: string }[] = [];
      const valid = ids.filter(i => /^\d+$|^gid:\/\/shopify\/Product\//.test(String(i)));
      if (valid.length) for (const p of await productsByIds(q, valid, 'id title variants(first: 1) { nodes { sku } }', 50)) out.push({ id: shortId(p.id), number: p.variants?.nodes?.[0]?.sku ?? undefined, name: p.title });
      for (let i = 0; i < numbers.length; i += 50) {
        const chunk = numbers.slice(i, i + 50);
        const r = await q<Json>('query BySku($first: Int!, $query: String) { productVariants(first: $first, query: $query) { nodes { sku product { id title } } } }', { first: 100, query: chunk.map(n => qField('sku', n)).join(' OR ') });
        for (const v of r.productVariants.nodes) if (chunk.includes(v.sku)) out.push({ id: shortId(v.product.id), number: v.sku, name: v.product.title });
      }
      return out;
    },
    async findCategories(ids) {
      const valid = ids.filter(i => /^\d+$|^gid:\/\/shopify\/Collection\//.test(String(i)));
      return valid.length ? (await collectionsByIds(q, valid, 'id title')).map(c => ({ id: shortId(c.id), name: c.title })) : [];
    },
    async getProduct(id) {
      if (!/^\d+$|^gid:\/\/shopify\/Product\//.test(String(id))) return null;
      const [p] = await productsByIds(q, [id], 'id title variants(first: 1) { nodes { sku barcode } } collections(first: 50) { nodes { id } }', 1);
      return p ? { id: shortId(p.id), number: p.variants?.nodes?.[0]?.sku ?? undefined, name: p.title, ean: p.variants?.nodes?.[0]?.barcode ?? undefined, categoryIds: (p.collections?.nodes ?? []).map((c: Json) => shortId(c.id)) } : null;
    },
    async mediaUrl(id) {
      if (!/^\d+$|^gid:\/\/shopify\/MediaImage\//.test(String(id))) return undefined;
      return (await mediaByIds(q, [id]))[0]?.image?.url;
    },
    async mapUrls(urls, o = {}) {
      const out = new Map<string, PageRef | null>(), parsed = new Map(urls.map(u => [u, parseShopPath(u)]));
      const found: Record<LinkKind, Map<string, Json>> = { product: new Map(), category: new Map(), landing: new Map() };
      for (const kind of ['product', 'category', 'landing'] as LinkKind[]) {
        const hs = [...new Set([...parsed.values()].filter(p => p?.kind === kind).map(p => p!.handle!.toLowerCase()))];
        if (hs.length) found[kind] = await byHandles(q, kind, hs);
      }
      for (const u of urls) {
        const p = parsed.get(u);
        if (!p) { out.set(u, null); continue; }
        if (p.kind === 'home') { out.set(u, { kind: 'home', name: 'Startseite' }); continue; }
        const e = found[p.kind].get(p.handle!.toLowerCase());
        if (!e) { out.set(u, null); continue; }
        out.set(u, { kind: p.kind, id: shortId(e.id), name: e.title, ...(e.variants?.nodes?.[0]?.sku ? { number: e.variants.nodes[0].sku } : {}),
          active: p.kind === 'product' ? e.status === 'ACTIVE' : p.kind === 'landing' ? e.isPublished !== false : true, ...(o.metas ? metas(p.kind, e) : {}) });
      }
      return out;
    },
    async entityPaths(kind, id) {
      const type = { product: 'Product', category: 'Collection', landing: 'Page' }[kind];
      const r = await q<{ nodes: (Json | null)[] }>('query Handle($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { handle } ... on Collection { handle } ... on Page { handle } } }', { ids: [toGid(type, id)] });
      const h = r.nodes[0]?.handle; if (!h) return { paths: [], urls: [] };
      const path = `${ROOT[kind]}/${h}`, b = await base().catch(() => '');
      return { paths: [path], urls: b ? [`${b}/${path}`] : [] };
    },
    async current(entity, id) {
      if (entity === 'product') { const [p] = await productsByIds(q, [id], 'id title descriptionHtml status seo { title description }', 1); return p ? { id: shortId(p.id), name: p.title, description: p.descriptionHtml, metaTitle: p.seo?.title ?? null, metaDescription: p.seo?.description ?? null, active: p.status === 'ACTIVE' } : null; }
      if (entity === 'category') { const [c] = await collectionsByIds(q, [id], 'id title descriptionHtml seo { title description }'); return c ? { id: shortId(c.id), name: c.title, description: c.descriptionHtml, metaTitle: c.seo?.title ?? null, metaDescription: c.seo?.description ?? null } : null; }
      if (entity === 'landing-page') { const [p] = await pagesByIds(q, [id]); return p ? { id: shortId(p.id), name: p.title, description: p.body, url: p.handle, ...metas('landing', p) } : null; }
      return null;
    },
  };
}

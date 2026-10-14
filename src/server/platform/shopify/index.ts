import 'server-only';
// Shopify adapter (Admin GraphQL API, token of a custom app). Reads for the AI only via the protected reader (allowlist of
// root fields, no customers/orders/staff/payments), writes only via change sets with exact undo (docs/platform.md).
import type { CategoryRow, ProductRow, UndoOp } from '@/lib/protocol';
import { PLATFORM_SETTINGS } from '@/lib/platforms';
import { accessAdd } from '../../db';
import { getSettings, shopConfigured } from '../../settings';
import { singleton } from '../../state';
import { applierRegistry } from '../appliers';
import { GENERIC_BLOCKS } from '../../cms';
import type { PlatformAdapter, PlatformCapabilities } from '../types';
import { applyAltTexts, applyCollectionProducts, applyCollections, applyHandles, applyImagesSet, applyNewCollections } from './catalog';
import { ShopifyClient, shopifyConf, shortId, type Json } from './client';
import { applyPromotion, applyPromotionStatus, applyTranslations } from './content';
import { productQuery, searchCollections, searchProducts, shopInfo, type Q, type ShopInfo } from './data';
import { shopifyLookup } from './lookup';
import { undoShopify } from './ops';
import { shopifyPages } from './pages';
import { applyShopifyPublish, type ShopifyPublishPayload } from './publish';
import { applyBulk, applyProducts, applyVariants, createProduct, type NewProductPayload } from './products';
import { ShopifyReader } from './reader';
import { applyShopifyImport, IMPORT_KIND_SHOPIFY, shopifyImportFeature, type ShopifyImportPayload } from './import';
import { SHOPIFY_TOOL_NAMES, shopifyTools } from './tools';

interface Runtime { client: ShopifyClient; shop: Promise<ShopInfo> | null; handles: Map<string, string> }
const rt = () => singleton<Runtime>('shopify-runtime', () => ({ client: new ShopifyClient(() => shopifyConf()), shop: null, handles: new Map() }));
/** Privileged client: stays on the server, is NEVER given to the AI */
export const shopifyClient = () => rt().client;
const shopCached = () => { const r = rt(); if (!r.shop) { r.shop = shopInfo((d, v) => r.client.gql(d, v)); r.shop.catch(() => { r.shop = null; }); } return r.shop; };
const publicBase = async () => { let pub = ''; try { pub = shopifyConf().publicUrl; } catch { /* not set up */ } return pub || (await shopCached()).primaryUrl; };

/** Protected read client (allowlist, scopes from the settings, access log under chat) */
export const shopifyReader = (chat: string) => new ShopifyReader(shopifyClient(), { chat, getScopes: () => getSettings().scopes, onAccess: a => accessAdd({ chat, ...a }) });

// Executor per change type (only after approval, privileged client)
const reg = applierRegistry<ShopifyClient>('shopify');
reg.register('products', (c, cs, _p, sel, ctx) => applyProducts(c, cs, sel, ctx));
reg.register('variants', (c, cs, _p, sel, ctx) => applyVariants(c, cs, sel, ctx));
reg.register('bulk-products', (c, cs, p, sel, ctx) => applyBulk(c, cs, p as Parameters<typeof applyBulk>[2], sel, ctx));
reg.register('new-products', async (c, cs, _p, sel, ctx) => {
  const results: { itemId: string; ok: boolean; error?: string }[] = [], undo: UndoOp[] = [], list = cs.items.filter(i => sel.has(i.id));
  for (const it of list) {
    try { await createProduct(c, it.afterRaw as NewProductPayload, undo); results.push({ itemId: it.id, ok: true }); }
    catch (e) { results.push({ itemId: it.id, ok: false, error: e instanceof Error ? e.message : String(e) }); }
    ctx?.progress?.(results.length, list.length, { results, undo });
  }
  return { results, undo };
});
reg.register('categories', (c, cs, _p, sel, ctx) => applyCollections(c, cs, sel, ctx));
reg.register('collections', (c, cs, _p, sel, ctx) => applyNewCollections(c, cs, sel, ctx));
reg.register('collection-products', (c, cs, _p, sel, ctx) => applyCollectionProducts(c, cs, sel, ctx));
reg.register('product-media', (c, cs, _p, sel, ctx) => applyImagesSet(c, cs, sel, ctx));
reg.register('alt-texts', (c, cs, _p, sel, ctx) => applyAltTexts(c, cs, sel, ctx));
reg.register('handles', (c, cs, _p, sel, ctx) => applyHandles(c, cs, sel, ctx));
reg.register('translations', (c, cs, _p, sel, ctx) => applyTranslations(c, cs, sel, ctx));
reg.register('promotion', (c, cs, p, sel, ctx) => applyPromotion(c, cs, p as Parameters<typeof applyPromotion>[2], sel, ctx));
reg.register('promotion-status', (c, cs, _p, sel, ctx) => applyPromotionStatus(c, cs, sel, ctx));
reg.register('page', (c, cs, p, _sel, ctx) => applyShopifyPublish(c, cs, p as ShopifyPublishPayload, { ctx }));
reg.register(IMPORT_KIND_SHOPIFY, (c, cs, p, sel, ctx) => applyShopifyImport(c, cs, p as ShopifyImportPayload, sel, ctx));

/** Pages on Shopify: landing pages (Online Store pages), collection and product templates in the theme; theme-main marks the theme content */
export const SHOPIFY_CAPABILITIES: PlatformCapabilities = { pageTypes: ['landingpage', 'product_list', 'product_detail'], publishTargets: ['landingpage', 'category', 'product'], blocks: [...GENERIC_BLOCKS, 'theme-main'], pageFormat: 'html', reuse: false };

/** Admin API scopes that Lotse needs for all tools (note in the connection test) */
export const NEEDED_SCOPES = ['read_products', 'write_products', 'read_files', 'write_files', 'read_content', 'write_content', 'read_themes', 'write_themes', 'read_translations', 'write_translations', 'read_locales', 'read_discounts', 'write_discounts', 'read_publications', 'write_publications', 'read_online_store_navigation', 'write_online_store_navigation'];
const PRIVATE_SCOPES = /^(read|write)_(customers|orders|draft_orders|all_orders|users|gift_cards|checkouts|payment)/;

/** Storefront path with short ID (/products/123, /collections/45) → handle path; context selection returns IDs, the storefront only knows handles */
async function storefrontPath(url: string): Promise<string> {
  const m = /^(.*?\/(products|collections))\/(\d+)(\/?(?:[?#].*)?)$/.exec(url); if (!m) return url;
  const r = rt(), key = `${m[2]}:${m[3]}`;
  let h = r.handles.get(key);
  if (!h) {
    const type = m[2] === 'products' ? 'Product' : 'Collection';
    const d = await r.client.gql<Json>('query Handle($id: ID!) { node(id: $id) { ... on Product { handle } ... on Collection { handle } } }', { id: `gid://shopify/${type}/${m[3]}` });
    h = d.node?.handle; if (!h) return url;
    r.handles.set(key, h);
  }
  return `${m[1]}/${h}${m[4]}`;
}

export const shopify: PlatformAdapter = {
  kind: 'shopify',
  label: 'Shopify',
  settings: PLATFORM_SETTINGS.shopify,
  capabilities: SHOPIFY_CAPABILITIES,
  promptVars: { shop: 'Shopify-Shop', platform: 'Shopify', htmlElement: 'HTML-Abschnitt der Seite', shopcheckTools: ' (seo_audit, find_image_gaps, get_product_images …)' },
  configured: () => shopConfigured('shopify'),
  reconfigure: () => { const r = rt(); r.client = new ShopifyClient(() => shopifyConf()); r.shop = null; r.handles.clear(); },

  async testConnection() {
    const c = shopifyClient(), s = await shopInfo((d, v) => c.gql(d, v));
    let hint = '';
    try {
      const sc: string[] = (await c.gql<Json>('query Scopes { currentAppInstallation { accessScopes { handle } } }')).currentAppInstallation.accessScopes.map((x: Json) => x.handle);
      const missing = NEEDED_SCOPES.filter(x => !sc.includes(x) && !(x.startsWith('read_') && sc.includes(x.replace('read_', 'write_'))));
      const extra = sc.filter(x => PRIVATE_SCOPES.test(x));
      if (missing.length) hint += ` Fehlende Berechtigungen (einige Werkzeuge gehen dann nicht): ${missing.join(', ')}.`;
      if (extra.length) hint += ` Hinweis: Die App darf auch ${extra.join(', ')}; Lotse liest solche Daten nie, du kannst die Berechtigung entfernen.`;
    } catch { /* scopes not readable: don't abort */ }
    return { ok: true, message: `Verbunden mit Shopify (${s.name}, API ${c.apiVersion}).${hint}` };
  },
  async health() {
    let url = ''; try { url = shopifyConf().publicUrl || `https://${shopifyConf().domain}`; } catch { /* not set up */ }
    try { const s = await shopCached(); return { url: shopifyConf().publicUrl || s.primaryUrl || url, ok: true }; }
    catch (e) { return { url, ok: false, error: e instanceof Error ? e.message : String(e) }; }
  },
  async urls() {
    let admin = '', storefront = '';
    try { admin = `https://${(await shopCached()).myshopifyDomain}`; storefront = await publicBase(); } catch { try { admin = shopifyConf().origin; } catch { /* not set up */ } }
    return { admin, storefront, paths: { adminCategory: '/admin/collections/{id}', adminProduct: '/admin/products/{id}', adminCms: '/admin/pages/{id}', category: '/collections/{id}', product: '/products/{id}' } };
  },

  openSession(chat) {
    const reader = shopifyReader(chat); // privileged client stays in the adapter
    return { reader, lookup: shopifyLookup(reader), storefrontFetch: async (u, i) => fetch(await storefrontPath(u), i), themeCss: async () => null };
  },
  lookup: reader => { if (!(reader instanceof ShopifyReader)) throw new Error('Shopify: Lese-Client erwartet'); return shopifyLookup(reader); },
  toolNames: SHOPIFY_TOOL_NAMES,
  tools: shopifyTools,
  features: [shopifyImportFeature],
  loadChecks: async () => { await import('./checks'); },
  scanProducts: async r => (await import('./checks')).neutralScan(r as ShopifyReader),

  apply: (cs, payload, selected, ctx) => reg.apply(shopifyClient(), cs, payload, selected, ctx),
  undo: ops => undoShopify(shopifyClient(), ops),
  pages: shopifyPages,

  context: {
    // Context selection in the UI (human, not AI): collections flat, products with image
    async categories() {
      const q: Q = (d, v) => shopifyClient().gql(d, v), out: CategoryRow[] = []; let after: string | null = null;
      for (let i = 0; i < 10; i++) {
        const r = await searchCollections(q, undefined, 100, after);
        out.push(...r.nodes.map((c): CategoryRow => ({ id: shortId(c.id), name: c.title, parentId: null, active: !!c.onlineStoreUrl, type: c.ruleSet ? 'smart' : 'manual', cmsPage: null })));
        if (!r.pageInfo.hasNextPage) break; after = r.pageInfo.endCursor;
      }
      return out;
    },
    async products({ term, categoryId }) {
      const r = await searchProducts((d, v) => shopifyClient().gql(d, v), productQuery({ term: term ?? undefined, collectionId: categoryId ?? undefined }), { first: 30, sortKey: term ? 'RELEVANCE' : 'TITLE' });
      return r.nodes.map((p): ProductRow => ({ id: shortId(p.id), name: p.title, number: p.variants?.nodes?.[0]?.sku ?? '', img: p.featuredMedia?.image?.url, cmsPage: null }));
    },
  },

  storefront: { base: async () => (await publicBase()).replace(/\/+$/, ''), fetch: async (u, i) => fetch(await storefrontPath(u), i) },
};

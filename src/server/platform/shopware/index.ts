import 'server-only';
// Shopware 6 adapter: wraps the existing code (shopware.ts, changes.ts, runtime.ts, features/*) in the platform contract.
import type { CategoryRow, ProductRow } from '@/lib/protocol';
import { PLATFORM_SETTINGS } from '@/lib/platforms';
import { applyChangeSet, undoOps } from '../../changes';
import { accessAdd } from '../../db';
import { createGuard } from '../../policy';
import { applyRuntime, shop, storefrontBase, storefrontFetch, themeCss } from '../../runtime';
import { getSettings, shopConfigured } from '../../settings';
import { ReadOnlyShopware, type ShopReader } from '../../shopware';
import type { PlatformAdapter } from '../types';
import { clearShopCache } from './cache';
import { shopwareLookup } from './lookup';
import { shopwarePages } from './pages';
import { shopwareSales } from './sales';
import { shopwareBrandSources } from '../../styleguide';
import { SHOPWARE_TOOL_NAMES, shopwareTools } from './tools';

/** Guarded read client as in the chat: allow-list (policy.ts), scopes from the settings, access log under chat. */
export const shopwareReader = (chat: string) => new ReadOnlyShopware(shop(), createGuard({ getScopes: () => getSettings().scopes, onAccess: a => accessAdd({ chat, ...a }) }));

export const shopware: PlatformAdapter = {
  kind: 'shopware',
  label: 'Shopware',
  settings: PLATFORM_SETTINGS.shopware,
  capabilities: { pageTypes: ['landingpage', 'product_list', 'product_detail'], publishTargets: ['category', 'product', 'landingpage'], categoryPageTypes: ['product_list', 'landingpage'], blocks: 'all', pageFormat: 'cms', reuse: true },
  promptVars: { shop: 'Shopware-6-Shop', platform: 'Shopware', htmlElement: 'Shopware-HTML-Element', shopcheckTools: ' (seo_audit, find_image_gaps, get_product_details …)' },
  configured: () => shopConfigured('shopware'),
  reconfigure: applyRuntime,

  async testConnection() {
    const sw = shop(); await sw.auth();
    const v = await sw.req('GET', '/_info/version');
    return { ok: true, message: `Verbunden mit Shopware ${v.version}` };
  },
  async health() {
    const sw = shop(), out: { url: string; ok: boolean; error?: string } = { url: sw.publicUrl || sw.base, ok: false };
    try { await sw.auth(); out.ok = true; } catch (e) { out.error = e instanceof Error ? e.message : String(e); }
    return out;
  },
  async urls() {
    const sw = shop();
    let storefront = sw.publicUrl;
    try { storefront = await storefrontBase(); } catch {}
    return { admin: sw.publicUrl, storefront, paths: { adminCategory: '/admin#/sw/category/index/{id}', adminProduct: '/admin#/sw/product/detail/{id}/base', adminCms: '/admin#/sw/cms/detail/{id}', category: '/navigation/{id}', product: '/detail/{id}' } };
  },

  openSession(chat) {
    const reader = shopwareReader(chat); // privileged client stays on the server, is NEVER given to the AI
    return { reader, lookup: shopwareLookup(reader), storefrontFetch, themeCss };
  },
  lookup: reader => shopwareLookup(reader as ShopReader),
  toolNames: SHOPWARE_TOOL_NAMES,
  tools: shopwareTools,
  loadChecks: async () => { await import('../../features'); },
  scanProducts: async r => (await import('./scan')).scanNeutral(r as ShopReader),
  brand: r => shopwareBrandSources(r as ShopReader),
  // fixed query via the privileged client: the AI's read client has no access to orders (features/sales.ts)
  sales: range => shopwareSales(shop(), range),

  // After a successful write (including undo) clear the Shopware cache so publications and changes are visible immediately
  async apply(cs, payload, selected, ctx) {
    const res = await applyChangeSet(shop(), cs, payload, selected, ctx);
    if ((res.counts?.applied ?? res.results.filter(r => r.ok).length) > 0) await clearShopCache(shop(), `apply:${cs.kind}`);
    return res;
  },
  async undo(ops) {
    const res = await undoOps(shop(), ops);
    if (res.some(r => r.ok)) await clearShopCache(shop(), 'undo');
    return res;
  },
  pages: shopwarePages,

  context: {
    // UI context selection (human, not AI): via the privileged client as before
    async categories() {
      const out: CategoryRow[] = []; // paginated: large shops have far more than 500 categories
      for (let page = 1; page <= 40; page++) {
        const r = await shop().search('category', { limit: 500, page, sort: [{ field: 'level', order: 'ASC' }, { field: 'name', order: 'ASC' }], associations: { cmsPage: {} } });
        out.push(...r.data.map((c): CategoryRow => ({ id: c.id, name: c.translated?.name ?? c.name, parentId: c.parentId, active: c.active, type: c.type, cmsPage: c.cmsPage?.name ?? null })));
        if (r.data.length < 500) break;
      }
      return out;
    },
    async products({ term, categoryId }) {
      const r = await shop().search('product', {
        limit: 30, ...(term ? { term } : {}),
        filter: [{ type: 'equals', field: 'parentId', value: null }, ...(categoryId ? [{ type: 'equals', field: 'categoriesRo.id', value: categoryId }] : [])],
        associations: { cover: { associations: { media: {} } }, cmsPage: {} },
      });
      return r.data.map((p): ProductRow => ({ id: p.id, name: p.translated?.name ?? p.name, number: p.productNumber, img: p.cover?.media?.url, cmsPage: p.cmsPage?.name ?? null }));
    },
  },

  storefront: { base: storefrontBase, fetch: (u, i) => shop().storefrontFetch(u, i) },
};

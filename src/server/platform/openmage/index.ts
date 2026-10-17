import 'server-only';
// OpenMage adapter (Magento 1): talks exclusively to the JSON API of the Lotse module Lotse_Connector (integrations/openmage).
// Reading only via the protected read client (reader.ts), writing only via change sets with exact undo (write.ts,
// catalog.ts, images.ts, promo.ts, variants.ts, bulk.ts, cms.ts, pages.ts, importer.ts). Shop-Check: checks.ts.
import type { CategoryRow, ProductRow } from '@/lib/protocol';
import { PLATFORM_SETTINGS } from '@/lib/platforms';
import { accessAdd } from '../../db';
import { getSettings, platformConfig, shopConfigured, redact } from '../../settings';
import { singleton } from '../../state';
import type { PlatformAdapter } from '../types';
import { OmClient, type OmConfig } from './client';
import { basisWord, type OmCategory } from './map';
import { createOmGuard, infoHasTermFilter, OmReader } from './reader';
import { omLookup } from './lookup';
import { OPENMAGE_CAPABILITIES, openmagePages } from './pages';
import { openmageImport } from './importer';
import { OPENMAGE_TOOL_NAMES, openmageReader, openmageTools } from './tools';
import { openmageSales } from './sales';
import { omBrandSources } from './brand';
import { reg, undoOpenmage } from './write';
import './catalog'; import './images'; import './promo'; import './variants'; import './bulk'; import './cms'; // register their executors

const config = (): OmConfig => { const c = platformConfig('openmage', getSettings()); return { url: c.url, publicUrl: c.publicUrl, storeCode: c.storeCode, token: c.token }; };
/** Privileged client (one per process), reconfigured after the settings are saved */
export const openmageClient = () => singleton('openmage-client', () => new OmClient(config()));
/** Protected read client for a session or the shop check (chat = name in the access log) */
export const openmageReaderFor = (chat: string, c = openmageClient()) => new OmReader(c, createOmGuard({ getScopes: () => getSettings().scopes, onAccess: a => accessAdd({ chat, ...a }) }));

export const openmage: PlatformAdapter = {
  kind: 'openmage',
  label: 'OpenMage',
  settings: PLATFORM_SETTINGS.openmage,
  capabilities: OPENMAGE_CAPABILITIES,
  promptVars: { shop: 'OpenMage-Shop', platform: 'OpenMage', htmlElement: 'HTML-Abschnitt der Seite', shopcheckTools: ' (seo_audit, find_image_gaps, list_products, get_cms_page …)' },
  configured: () => shopConfigured('openmage'),
  reconfigure: () => { openmageClient().configure(config()); },

  async testConnection() {
    const c = openmageClient();
    if (!c.configured) return { ok: false, message: 'OpenMage-Zugang unvollständig: Shop-URL und API-Token des Lotse-Moduls eintragen.' };
    try {
      c.resetInfo();
      const info = await c.info(), main = await c.workStore(), view = info.store_views.find(v => v.code === main);
      if (!view) return { ok: false, message: `Store-View „${main}“ gibt es nicht. Vorhanden: ${info.store_views.filter(v => v.id > 0).map(v => v.code).join(', ')}` };
      const n = await c.list('/v1/products', { limit: 1 });
      return { ok: true, message: `Verbunden mit ${info.shop_name || 'OpenMage'} (OpenMage ${info.version}, Modul ${info.module_version}): Store-View ${view.name} (${view.code}${view.locale ? `, ${view.locale}` : ''}${view.currency ? `, ${view.currency}` : ''}), ${n.meta.total} Produkte, Preise ${basisWord(await c.priceBasis())}` };
    } catch (e) { return { ok: false, message: redact(e instanceof Error ? e.message : e) }; }
  },
  async health() {
    const c = openmageClient(), out: { url: string; ok: boolean; error?: string } = { url: c.publicUrl || c.base, ok: false };
    if (!c.configured) { out.error = 'OpenMage ist noch nicht verbunden (Einstellungen).'; return out; }
    // without the info() cache: the sidebar should show an outage, a disabled module or a rotated token
    try { await c.req('GET', '/v1/info'); out.ok = true; } catch (e) { out.error = redact(e instanceof Error ? e.message : e); }
    return out;
  },
  async urls() {
    const c = openmageClient();
    let storefront = c.publicUrl;
    try { storefront = await openmageReaderFor('system').storefrontBase(); } catch {}
    return { admin: `${c.publicUrl}/index.php/admin`, storefront, paths: { adminCategory: '/catalog_category/edit/id/{id}', adminProduct: '/catalog_product/edit/id/{id}', adminCms: '/cms_page/edit/page_id/{id}', category: '/catalog/category/view/id/{id}', product: '/catalog/product/view/id/{id}' } };
  },

  openSession(chat) {
    const reader = openmageReaderFor(chat); // privileged client stays in the adapter
    return { reader, lookup: omLookup(reader), storefrontFetch: (u, i) => openmageClient().storefrontFetch(u, i), themeCss: async () => null };
  },
  lookup: reader => omLookup(reader as OmReader),
  toolNames: OPENMAGE_TOOL_NAMES,
  tools: openmageTools,
  features: [openmageImport],
  loadChecks: async () => { await import('./checks'); },
  scanProducts: async r => (await import('./checks')).neutralScan(r as OmReader),
  brand: r => omBrandSources(r as OmReader),
  // fixed module endpoint (sums per product) via the privileged client; the AI's read client denies /v1/sales
  sales: range => openmageSales(openmageClient(), range),

  apply: async (cs, payload, selected, ctx) => reg.apply(openmageClient(), cs, payload, selected, ctx),
  undo: ops => undoOpenmage(openmageClient(), ops),
  pages: openmagePages(openmageReader),

  context: {
    // Context selection in the UI (human, not AI): category tree and products via the privileged client
    async categories() {
      const c = openmageClient(), roots = await c.req('GET', '/v1/categories', undefined, { store: await c.workStore() }) as OmCategory[];
      const out: CategoryRow[] = [];
      const walk = (x: OmCategory, parent: string | null) => { if (Number(x.level) >= 1) out.push({ id: String(x.id), name: String(x.name ?? x.id), parentId: Number(x.level) > 1 ? parent : null, active: !!x.is_active, type: 'page', cmsPage: null }); for (const k of x.children ?? []) walk(k, Number(x.level) >= 1 ? String(x.id) : null); };
      for (const r of roots) walk(r, null);
      return out;
    },
    async products({ term, categoryId }) {
      const c = openmageClient(), info = await c.info(), store = await c.workStore(), base = { ...(categoryId ? { category_id: categoryId } : {}), visibility: '2,3,4', limit: 30 };
      // Search term in name OR SKU: one query (module 1.2.0+), otherwise two merged ones
      const lists = term && !infoHasTermFilter(info) ? await Promise.all([c.list('/v1/products', { ...base, name: term }, store), c.list('/v1/products', { ...base, sku: term }, store)]) : [await c.list('/v1/products', { ...base, ...(term ? { term } : {}) }, store)];
      const items = lists.flatMap(l => l.items).filter((p, i, arr) => arr.findIndex(x => x.id === p.id) === i).slice(0, 30);
      const media = (info.store_views.find(v => v.code === store)?.media_url ?? `${c.publicUrl || c.base}/media/`).replace(/\/?$/, '/');
      return items.map((p): ProductRow => ({ id: String(p.id), name: String(p.name ?? p.sku), number: p.sku, img: p.image && p.image !== 'no_selection' ? `${media}catalog/product${p.image}` : undefined, cmsPage: null }));
    },
  },

  storefront: {
    base: async () => { const c = openmageClient(); if (!c.base) throw new Error('OpenMage ist noch nicht verbunden (Einstellungen).'); return openmageReaderFor('vorschau').storefrontBase().catch(() => c.publicUrl); },
    fetch: (u, i) => openmageClient().storefrontFetch(u, i),
  },
};

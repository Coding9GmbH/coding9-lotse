import 'server-only';
// Magento 2 adapter: REST API /rest/<store>/V1 (products, categories, gallery, MSI stock, cart price rules, store views)
// and public GraphQL (URL resolution, storefront config). Reads only via the protected read client (reader.ts),
// writes only via change sets with exact undo (write.ts, catalog.ts, images.ts, promo.ts, variants.ts, bulk.ts, cms.ts,
// pages.ts for pages in Page Builder format, importer.ts for supplier data). Shop check: checks.ts.
import type { CategoryRow, ProductRow } from '@/lib/protocol';
import { PLATFORM_SETTINGS } from '@/lib/platforms';
import { accessAdd } from '../../db';
import { getSettings, platformConfig, shopConfigured, redact } from '../../settings';
import { singleton } from '../../state';
import type { PlatformAdapter } from '../types';
import { MagentoClient, type MagentoConfig } from './client';
import { likeTerm } from './criteria';
import { attrStr, basisWord, type MCategory } from './map';
import { createMagentoGuard, MagentoReader } from './reader';
import { magentoLookup } from './lookup';
import { MAGENTO_CAPABILITIES, magentoPages } from './pages';
import { magentoImport } from './importer';
import { MAGENTO_TOOL_NAMES, magentoReader, magentoTools } from './tools';
import { reg, resetMainStore, undoMagento } from './write';
import './catalog'; import './images'; import './promo'; import './variants'; import './bulk'; // register their executors

const config = (): MagentoConfig => { const c = platformConfig('magento', getSettings()); return { url: c.url, publicUrl: c.publicUrl, storeCode: c.storeCode, accessToken: c.accessToken, user: c.user, password: c.password, priceBasis: c.priceBasis }; };
/** Privileged client (one per process), reconfigured after the settings are saved */
export const magentoClient = () => singleton('magento-client', () => new MagentoClient(config()));
/** Protected read client for a session or the shop check (chat = name in the access log) */
export const magentoReaderFor = (chat: string, c = magentoClient()) => new MagentoReader(c, createMagentoGuard({ getScopes: () => getSettings().scopes, onAccess: a => accessAdd({ chat, ...a }) }));

export const magento: PlatformAdapter = {
  kind: 'magento',
  label: 'Magento',
  settings: PLATFORM_SETTINGS.magento,
  capabilities: MAGENTO_CAPABILITIES,
  promptVars: { shop: 'Magento-2-Shop', platform: 'Magento', htmlElement: 'HTML-Abschnitt der Seite', shopcheckTools: ' (seo_audit, find_image_gaps, list_products, get_cms_page …)' },
  configured: () => shopConfigured('magento'),
  reconfigure: () => { magentoClient().configure(config()); resetMainStore(magentoClient()); },

  async testConnection() {
    const c = magentoClient();
    if (!c.configured) return { ok: false, message: 'Magento-Zugang unvollständig: Shop-URL und Zugriffstoken (oder Admin-Benutzer + Passwort) eintragen.' };
    try {
      const views = await c.req('GET', '/V1/store/storeViews', undefined, { store: 'all' }) as { code: string; name: string }[];
      const view = views.find(v => v.code === c.storeCode);
      if (!view) return { ok: false, message: `Store-View „${c.storeCode}“ gibt es nicht. Vorhanden: ${views.filter(v => v.code !== 'admin').map(v => v.code).join(', ')}` };
      const cfg = ((await c.req('GET', '/V1/store/storeConfigs', undefined, { store: 'all' })) as { code: string; locale?: string; base_currency_code?: string }[]).find(x => x.code === c.storeCode);
      const n = await c.search('/V1/products', { pageSize: 1 }, { store: 'all', fields: 'total_count' });
      const ver = await c.storefrontFetch(`${c.base}/magento_version`).then(r => (r.ok ? r.text() : '')).catch(() => '');
      return { ok: true, message: `Verbunden mit Magento${/^Magento\//.test(ver) ? ` (${ver.trim().slice(0, 40)})` : ''}: Store-View ${view.name} (${c.storeCode}${cfg?.locale ? `, ${cfg.locale}` : ''}${cfg?.base_currency_code ? `, ${cfg.base_currency_code}` : ''}), ${n.total_count} Produkte, Preise ${c.priceBasis ? basisWord(c.priceBasis) : 'brutto/netto noch nicht festgelegt (Lotse ändert bis dahin keine Preise)'}` };
    } catch (e) { return { ok: false, message: redact(e instanceof Error ? e.message : e) }; }
  },
  async health() {
    const c = magentoClient(), out: { url: string; ok: boolean; error?: string } = { url: c.publicUrl || c.base, ok: false };
    if (!c.configured) { out.error = 'Magento ist noch nicht verbunden (Einstellungen).'; return out; }
    try { await c.req('GET', '/V1/store/storeViews', undefined, { store: 'all' }); out.ok = true; } catch (e) { out.error = redact(e instanceof Error ? e.message : e); }
    return out;
  },
  async urls() {
    const c = magentoClient();
    let storefront = c.publicUrl;
    try { storefront = await magentoReaderFor('system').storefrontBase(); } catch {}
    return { admin: c.publicUrl, storefront, paths: { adminCategory: '/admin/catalog/category/edit/id/{id}', adminProduct: '/admin/catalog/product/edit/id/{id}', adminCms: '/admin/cms/page/edit/page_id/{id}', category: '/catalog/category/view/id/{id}', product: '/catalog/product/view/id/{id}' } };
  },

  openSession(chat) {
    const reader = magentoReaderFor(chat); // privileged client stays in the adapter
    return { reader, lookup: magentoLookup(reader), storefrontFetch: (u, i) => magentoClient().storefrontFetch(u, i), themeCss: async () => null };
  },
  lookup: reader => magentoLookup(reader as MagentoReader),
  toolNames: MAGENTO_TOOL_NAMES,
  tools: magentoTools,
  features: [magentoImport],
  loadChecks: async () => { await import('./checks'); },
  scanProducts: async r => (await import('./checks')).neutralScan(r as MagentoReader),

  apply: async (cs, payload, selected, ctx) => reg.apply(magentoClient(), cs, payload, selected, ctx),
  undo: ops => undoMagento(magentoClient(), ops),
  pages: magentoPages(magentoReader),

  context: {
    // Context selection in the UI (human, not AI): category tree and products via the privileged client
    async categories() {
      const c = magentoClient(), tree = await c.req('GET', '/V1/categories', undefined, { store: c.storeCode }) as MCategory;
      const out: CategoryRow[] = [];
      const walk = (x: MCategory, parent: string | null) => { if (Number(x.level) >= 1) out.push({ id: String(x.id), name: String(x.name ?? x.id), parentId: Number(x.level) > 1 ? parent : null, active: !!x.is_active, type: 'page', cmsPage: null }); for (const k of x.children_data ?? []) walk(k, Number(x.level) >= 1 ? String(x.id) : null); };
      walk(tree, null);
      return out;
    },
    async products({ term, categoryId }) {
      const c = magentoClient(), ro = magentoReaderFor('system');
      const r = await c.search('/V1/products', { filters: [...(term ? [[{ field: 'name', value: likeTerm(term), condition_type: 'like' as const }, { field: 'sku', value: likeTerm(term), condition_type: 'like' as const }]] : []), ...(categoryId ? [[{ field: 'category_id', value: categoryId }]] : []), [{ field: 'visibility', value: [2, 3, 4], condition_type: 'in' as const }]], pageSize: 30 });
      // Image URL as in the tools via the store view's base_media_url (CDN, pub/media); fallback without shop config
      const img = (f: string | null) => ro.mediaUrl(f).catch(() => (f && f !== 'no_selection' ? `${c.publicUrl || c.base}/media/catalog/product${f}` : undefined));
      return Promise.all(r.items.map(async (p): Promise<ProductRow> => ({ id: String(p.id), name: String(p.name ?? p.sku), number: p.sku, img: await img(attrStr(p, 'small_image') ?? attrStr(p, 'thumbnail')), cmsPage: null })));
    },
  },

  storefront: {
    base: async () => { const c = magentoClient(); if (!c.base) throw new Error('Magento ist noch nicht verbunden (Einstellungen).'); return magentoReaderFor('vorschau').storefrontBase().catch(() => c.publicUrl); },
    fetch: (u, i) => magentoClient().storefrontFetch(u, i),
  },
};

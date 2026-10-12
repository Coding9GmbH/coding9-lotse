import 'server-only';
// Vorlage für künftige Adapter (heute ungenutzt, alle vier Plattformen sind fertig; siehe docs/platform.md §1): Einstellungen und Typen
// sind vollständig, Werkzeuge melden ehrlich „noch nicht verfügbar“. Wird beim Umsetzen durch einen echten Adapter ersetzt.
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { PLATFORM_SETTINGS, type PlatformKind } from '@/lib/platforms';
import type { ImageRef } from '../cms';
import { GENERIC_BLOCKS } from '../cms';
import { getSettings, platformConfig, shopConfigured } from '../settings';
import { fail, guard, type AnyTool } from '../tool-kit';
import type { PlatformAdapter, PlatformCapabilities, ShopLookup } from './types';

export class NotAvailableError extends Error { notAvailable = true as const; }

/** Lese-Werkzeuge mit den vereinbarten Namen (gleiche Namen auf allen Plattformen), die nur den Hinweis liefern */
const STUB_TOOLS = ['search_products', 'get_product', 'list_products', 'search_categories', 'get_category'];

export function stubAdapter(kind: Exclude<PlatformKind, 'shopware'>, o: { capabilities: PlatformCapabilities; promptVars: Record<string, string>; paths: { adminCategory: string; adminProduct: string; adminCms: string; category: string; product: string } }): PlatformAdapter {
  const d = PLATFORM_SETTINGS[kind], label = d.label;
  const msg = `Die ${label}-Anbindung ist in Lotse noch nicht verfügbar. Die Zugangsdaten sind gespeichert; Werkzeuge für ${label} folgen.`;
  const na = () => new NotAvailableError(msg);
  const base = () => { const c = platformConfig(kind, getSettings()); return (c.publicUrl || c.url || (c.storeDomain ? `https://${c.storeDomain}` : '')).replace(/\/$/, ''); };
  const lookup: ShopLookup = {
    findProducts: async () => { throw na(); }, findCategories: async () => { throw na(); }, getProduct: async () => { throw na(); },
    mediaUrl: async () => { throw na(); }, mapUrls: async () => { throw na(); }, entityPaths: async () => { throw na(); }, current: async () => { throw na(); },
  };
  return {
    kind, label, settings: d, capabilities: o.capabilities, promptVars: o.promptVars,
    configured: () => shopConfigured(kind),
    reconfigure: () => {},
    testConnection: async () => ({ ok: false, message: msg }),
    health: async () => ({ url: base(), ok: false, error: msg }),
    urls: async () => ({ admin: base(), storefront: base(), paths: o.paths }),
    openSession: () => ({ reader: { platform: kind }, lookup, storefrontFetch: (u, i) => fetch(u, i), themeCss: async () => null }),
    lookup: () => lookup,
    toolNames: STUB_TOOLS,
    tools: () => STUB_TOOLS.map(n => tool(n, `${label}: noch nicht verfügbar. Liefert nur einen Hinweis.`, { term: z.string().optional() }, guard(async () => fail(msg)))) as AnyTool[],
    loadChecks: async () => {},
    apply: async () => { throw na(); },
    undo: async ops => ops.map(() => ({ ok: false, error: msg })),
    pages: {
      previewData: async () => ({ imageUrl: (im: ImageRef) => (typeof im === 'string' ? im : im?.url) }),
      publishTool: { description: `${label}: Veröffentlichen ist noch nicht verfügbar.`, shape: { target: z.enum(o.capabilities.publishTargets as [string, ...string[]]) } },
      buildPublish: async () => { throw na(); },
    },
    context: { categories: async () => [], products: async () => [] },
    storefront: { base: async () => { const b = base(); if (!b) throw na(); return b; }, fetch: (u, i) => fetch(u, i) },
  };
}

/** Grundausstattung einer HTML-Plattform: freie Landingpages und Kategorie-/Kollektionsseiten aus generischen Blöcken */
export const HTML_CAPABILITIES: PlatformCapabilities = { pageTypes: ['landingpage', 'product_list'], publishTargets: ['landingpage', 'category'], blocks: GENERIC_BLOCKS, pageFormat: 'html', reuse: false };

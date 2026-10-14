import 'server-only';
// Shopware: page drafts (Shopping Experiences): preview data, preparing reuse blocks + SEO links, publishing as a change set.
import { z } from 'zod';
import type { ChatEvent } from '@/lib/protocol';
import { buildPublishChangeSet, type PublishArgs } from '../../changes';
import type { ShopReader } from '../../shopware';
import { resolveReuse, reuseRefs, type ImageRef, type PageSpec, type PreviewCtx, type PreviewProduct } from '../../cms';
import { stagedMeta } from '../../media';
import { extractBlocks, findDivByClass, REAL_BLOCK_TYPES, stripScripts } from '../../real-page';
import { storefrontBase, storefrontRewrite } from '../../runtime';
import { findingText, prepareSpecLinks } from '../../seo-links';
import type { Session } from '../../sessions';
import type { PlatformPages } from '../types';
import { brief, loadRawBlocks } from './tools';

const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));

/**
 * Real data instead of placeholders: if the draft names no sample product or sample category, an active product with a cover image
 * (for product_list its category) is picked from the shop. The choice is then stored in the spec so the UI shows the target.
 */
export async function withPreviewDefaults(sw: ShopReader, spec: PageSpec): Promise<PageSpec> {
  try {
    const needProduct = spec.type === 'product_detail' && !spec.previewProductId, needCategory = spec.type === 'product_list' && !spec.previewCategoryId;
    if (!needProduct && !needCategory) return spec;
    const filter: Record<string, unknown>[] = [
      { type: 'equals', field: 'active', value: true }, { type: 'equals', field: 'parentId', value: null },
      { type: 'not', operator: 'and', queries: [{ type: 'equals', field: 'coverId', value: null }] },
    ];
    if (needProduct && spec.previewCategoryId) filter.push({ type: 'equals', field: 'categoriesRo.id', value: spec.previewCategoryId });
    const p = (await sw.search('product', { limit: 1, filter, sort: [{ field: 'productNumber', order: 'ASC' }] })).data[0];
    if (!p) return spec;
    if (needProduct) return { ...spec, previewProductId: p.id };
    const cat = (p.categoryIds as string[] | undefined)?.[0];
    return cat ? { ...spec, previewCategoryId: cat } : spec;
  } catch { return spec; } // preview convenience: on errors the placeholders stay
}

// Briefly cache the real target page: each revision of the draft re-renders, but the page itself doesn't change
const REAL_PAGE_TTL = 60_000, REAL_PAGE_MAX = 1_500_000, REAL_PAGE_HOPS = 2;
const realPages = new Map<string, { at: number; html: string | null }>();

/**
 * HTML of the real target page (the shop's product or category page) for "draft on the real page": scripts removed, shop URLs to /shop.
 * null = not available (no target, error, page without CMS area); the preview then falls back to the simple rendering.
 */
async function realPageHtml(session: Session, spec: PageSpec): Promise<string | null> {
  const id = spec.type === 'product_detail' ? spec.previewProductId : spec.type === 'product_list' ? spec.previewCategoryId : null;
  if (!id || !/^[0-9a-f]{32}$/i.test(id)) return null;
  const path = spec.type === 'product_detail' ? `/detail/${id}` : `/navigation/${id}`;
  const hit = realPages.get(path);
  if (hit && Date.now() - hit.at < REAL_PAGE_TTL) return hit.html;
  let html: string | null = null;
  try {
    const base = await storefrontBase(), origin = new URL(base).origin;
    let url = base + path, r: Response | null = null;
    for (let hop = 0; hop <= REAL_PAGE_HOPS; hop++) {
      r = await session.storefrontFetch(url, { redirect: 'manual', headers: { accept: 'text/html', 'accept-language': 'de-DE,de' }, signal: AbortSignal.timeout(12_000) });
      const loc = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null;
      if (!loc) break;
      const next = new URL(loc, url);
      if (next.origin !== origin) { r = null; break; } // only within the shop
      url = next.href;
    }
    if (r?.ok && /text\/html/i.test(r.headers.get('content-type') ?? '')) {
      const text = await r.text();
      if (text.length <= REAL_PAGE_MAX) {
        const clean = stripScripts(storefrontRewrite(text, base));
        if (findDivByClass(clean, 'cms-sections')) html = clean;
      }
    }
  } catch { html = null; }
  realPages.set(path, { at: Date.now(), html });
  if (realPages.size > 50) for (const k of realPages.keys()) { realPages.delete(k); if (realPages.size <= 25) break; }
  return html;
}

async function previewData(session: Session, spec: PageSpec): Promise<PreviewCtx> {
  const { sw } = session;
  spec = await withPreviewDefaults(sw, spec);
  const ids = new Set<string>(); const mediaIds = new Set<string>();
  for (const s of spec.sections) for (const b of s.blocks) {
    (b.productIds ?? []).forEach(i => ids.add(i));
    for (const k of ['image', 'image2'] as const) { const im = b[k]; if (typeof im === 'object' && im?.mediaId) mediaIds.add(im.mediaId); }
    if (b.type === 'reuse') { const r = reuseRefs(b); r.productIds.forEach(i => ids.add(i)); r.mediaIds.forEach(i => mediaIds.add(i)); }
  }
  if (spec.previewProductId) ids.add(spec.previewProductId);
  if (spec.previewCategoryId) {
    const r = await sw.search('product', { limit: 8, filter: [{ type: 'equals', field: 'categoriesRo.id', value: spec.previewCategoryId }, { type: 'equals', field: 'active', value: true }], associations: { cover: { associations: { media: {} } } } });
    r.data.forEach(p => ids.add(p.id));
  }
  // Product page: more real products from the same category for the preview's cross-selling
  if (spec.type === 'product_detail' && spec.previewProductId && !spec.previewCategoryId) {
    try {
      const cat = ((await sw.get('product', spec.previewProductId))?.categoryIds as string[] | undefined)?.[0];
      if (cat) (await sw.search('product', { limit: 5, filter: [{ type: 'equals', field: 'categoriesRo.id', value: cat }, { type: 'equals', field: 'active', value: true }, { type: 'equals', field: 'parentId', value: null }] })).data.forEach(r => ids.add(r.id));
    } catch { /* preview only */ }
  }
  const products: Record<string, PreviewProduct> = {};
  for (const chunk of chunks([...ids], 50)) { // several sliders: all products, in blocks of 50
    const r = await sw.search('product', { ids: chunk, limit: chunk.length, associations: { cover: { associations: { media: {} } } } });
    for (const p of r.data) products[p.id] = { ...brief(p), img: p.cover?.media?.url, description: p.translated?.description ?? p.description, faqHtml: p.customFields?.aicb_blocks?.faq_html };
  }
  const media: Record<string, string | null | undefined> = {};
  const shopMedia = [...mediaIds].filter(id => !id.startsWith('staged:'));
  for (const chunk of chunks(shopMedia, 50)) { // one search instead of one fetch per image
    const r = await sw.search('media', { ids: chunk, limit: chunk.length }).catch(() => ({ data: [] as { id: string; url?: string }[] }));
    for (const id of chunk) media[id] = r.data.find(m => m.id === id)?.url ?? null;
  }
  for (const id of mediaIds) if (id.startsWith('staged:')) media[id] = `/staged/${stagedMeta(id.slice(7))?.file}`;
  const realPage = await realPageHtml(session, spec);
  return {
    products, product: spec.previewProductId ? products[spec.previewProductId] : undefined,
    imageUrl: (im: ImageRef) => (typeof im === 'string' ? im : im.url ?? media[im.mediaId ?? '']),
    // only blocks belonging to the page type (product cards in lists carry buy box markup)
    ...(realPage ? { realPage, realBlocks: extractBlocks(realPage, Object.fromEntries(Object.entries(REAL_BLOCK_TYPES).filter(([k]) => (spec.type === 'product_detail') === k.startsWith('pdp-')))) } : {}),
  };
}

/** Maximum number of pages per layout publication (narrow down larger sets beforehand) */
const SCOPE_MAX = 1000;

const PUBLISH_DESCRIPTION = 'BEANTRAGT die Veröffentlichung des aktuellen Entwurfs (neues CMS-Layout + Zuweisung + Meta-Daten + vorgemerkte Bilder). Es wird nichts geschrieben, bis der Nutzer die Übersicht freigibt; der Aufruf wartet auf die Entscheidung. target: category (Entwurfstyp product_list ODER landingpage; nur Kategorien vom Typ Listing/page, nie Strukturelement oder Link; die STARTSEITE eines Verkaufskanals ist dessen Einstiegskategorie (navigationCategoryId aus list_sales_channels) und bekommt ein landingpage-Layout), product (product_detail), landingpage (eigene URL: landingpage, url + salesChannelId). GELTUNGSBEREICH (Layout für mehrere Seiten): category = categoryId, categoryIds[] ODER allCategories=true (alle Kategorien); product = productIds[], productsInCategoryId (alle Produkte dieser Kategorie inkl. Unterkategorien) ODER allProducts=true. Genau eine Angabe je Aufruf; bis max. ' + SCOPE_MAX + ' Seiten. Der Server zählt und zeigt die Zahl in der Übersicht. Meta-Title/-Description nur bei einer einzelnen Kategorie. Frage den Nutzer vorher nach dem Bereich, wenn er ihn nicht eindeutig genannt hat.';

/** Resolve the scope (all products/categories, of one category …) into fixed ID lists; this way the approval writes exactly what was shown. */
export async function resolvePublishScope(sw: ShopReader, a: PublishArgs): Promise<PublishArgs> {
  const kinds = [a.allCategories, a.categoryIds?.length, a.allProducts, a.productsInCategoryId, a.productIds?.length].filter(Boolean).length;
  if (kinds > 1) throw new Error('Geltungsbereich mehrdeutig: nur eine Angabe (categoryIds, allCategories, productIds, productsInCategoryId oder allProducts).');
  const collect = async (entity: 'product' | 'category', filter: Record<string, unknown>[]) => {
    const ids: string[] = [];
    for (let page = 1; ; page++) {
      const r = await sw.search(entity, { limit: 500, page, filter, 'total-count-mode': 1, sort: [{ field: 'id', order: 'ASC' }] });
      ids.push(...r.data.map(x => x.id));
      if (ids.length > SCOPE_MAX) throw new Error(`Mehr als ${SCOPE_MAX} ${entity === 'product' ? 'Produkte' : 'Kategorien'} im Bereich: bitte auf eine Kategorie oder kleinere Gruppe eingrenzen.`);
      if (r.data.length < 500) return ids;
    }
  };
  if (a.target === 'category' && (a.allCategories || a.categoryIds?.length)) {
    if (a.allCategories) {
      const ids = await collect('category', [{ type: 'equals', field: 'type', value: 'page' }, { type: 'not', operator: 'and', queries: [{ type: 'equals', field: 'parentId', value: null }] }]);
      if (!ids.length) throw new Error('Keine Kategorien gefunden.');
      return { ...a, categoryIds: ids, scopeLabel: `Alle Kategorien (${ids.length})` };
    }
    const ids = [...new Set(a.categoryIds)];
    return { ...a, categoryIds: ids, scopeLabel: `${ids.length} ausgewählte Kategorie${ids.length === 1 ? '' : 'n'}` };
  }
  if (a.target === 'product' && (a.allProducts || a.productsInCategoryId)) {
    // Variants inherit the layout from the parent product
    const base: Record<string, unknown>[] = [{ type: 'equals', field: 'parentId', value: null }];
    let label = 'Alle Produkte';
    if (a.productsInCategoryId) {
      const cat = await sw.get('category', a.productsInCategoryId);
      if (!cat) throw new Error(`Kategorie ${a.productsInCategoryId} nicht gefunden`);
      base.push({ type: 'equals', field: 'categoriesRo.id', value: a.productsInCategoryId });
      label = `Alle Produkte der Kategorie „${cat.translated?.name ?? cat.name}“ (inkl. Unterkategorien)`;
    }
    const ids = await collect('product', base);
    if (!ids.length) throw new Error('Im gewählten Bereich gibt es keine Produkte.');
    return { ...a, productIds: ids, scopeLabel: `${label}: ${ids.length}` };
  }
  return a;
}

export const shopwarePages: PlatformPages = {
  previewData,

  async prepareDraft(session, input) {
    const reuseErrs = await resolveReuse(input, id => loadRawBlocks(session.sw, id)); // copies source blocks into the spec (stays in the draft for publishing)
    if (reuseErrs.length) return { spec: input, errors: reuseErrs };
    const withDefaults = await withPreviewDefaults(session.sw, input); // real sample product/category if none is named
    const { spec, report } = await prepareSpecLinks(session.sw, withDefaults); // technical links → SEO URL, check targets
    return { spec, links: report };
  },

  async focus(session, raw): Promise<ChatEvent | null> {
    const { sw } = session;
    if (raw.previewProductId) { const p = await sw.get('product', raw.previewProductId); if (p) return { t: 'focus', kind: 'product', id: p.id, name: p.translated?.name ?? p.name, path: p.productNumber, cmsPage: null }; }
    else if (raw.previewCategoryId) { const c = await sw.get('category', raw.previewCategoryId); if (c) return { t: 'focus', kind: 'category', id: c.id, name: c.translated?.name, path: c.translated?.breadcrumb?.slice(1).join(' › '), cmsPage: null }; }
    return null;
  },

  publishTool: {
    description: PUBLISH_DESCRIPTION,
    shape: {
      target: z.enum(['category', 'product', 'landingpage']),
      categoryId: z.string().optional(), categoryIds: z.array(z.string()).optional(), allCategories: z.boolean().optional(),
      productIds: z.array(z.string()).optional(), productsInCategoryId: z.string().optional(), allProducts: z.boolean().optional(),
      url: z.string().optional().describe('Landingpage-URL-Pfad, z.B. "ratgeber/gartenduschen"'), salesChannelId: z.string().optional(),
      metaTitle: z.string().optional(), metaDescription: z.string().optional(),
    },
  },

  async buildPublish(session, spec, args) {
    const a = await resolvePublishScope(session.sw, args as unknown as PublishArgs);
    if (a.target === 'category' && !a.categoryId && !a.categoryIds?.length) throw new Error('categoryId fehlt (oder categoryIds / allCategories)');
    if (a.target === 'product' && !a.productIds?.length) throw new Error('productIds fehlt (oder productsInCategoryId / allProducts)');
    if (a.target === 'landingpage' && (!a.url || !a.salesChannelId)) throw new Error('url und salesChannelId fehlen');
    const { spec: fixed, report } = await prepareSpecLinks(session.sw, spec, a.target === 'landingpage' ? a.salesChannelId : undefined); // keep SEO URLs up to date
    const cs = await buildPublishChangeSet(session.sw, fixed, a);
    cs.items[0]?.warn.push(...(report?.findings ?? []).filter(f => f.level === 'wichtig').slice(0, 5).map(findingText));
    return { cs, payload: { spec: fixed, args: a } };
  },
};

import 'server-only';
// Shopware: Seiten-Entwürfe (Einkaufswelten) – Vorschau-Daten, reuse-Blöcke + SEO-Links vorbereiten, Veröffentlichung als Änderungsset.
import { z } from 'zod';
import type { ChatEvent } from '@/lib/protocol';
import { buildPublishChangeSet, type PublishArgs } from '../../changes';
import { resolveReuse, reuseRefs, type ImageRef, type PageSpec, type PreviewCtx, type PreviewProduct } from '../../cms';
import { stagedMeta } from '../../media';
import { findingText, prepareSpecLinks } from '../../seo-links';
import type { Session } from '../../sessions';
import type { PlatformPages } from '../types';
import { brief, loadRawBlocks } from './tools';

const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));

async function previewData(session: Session, spec: PageSpec): Promise<PreviewCtx> {
  const { sw } = session;
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
  const products: Record<string, PreviewProduct> = {};
  for (const chunk of chunks([...ids], 50)) { // mehrere Slider: alle Produkte, in 50er-Blöcken
    const r = await sw.search('product', { ids: chunk, limit: chunk.length, associations: { cover: { associations: { media: {} } } } });
    for (const p of r.data) products[p.id] = { ...brief(p), img: p.cover?.media?.url, description: p.translated?.description ?? p.description, faqHtml: p.customFields?.aicb_blocks?.faq_html };
  }
  const media: Record<string, string | null | undefined> = {};
  const shopMedia = [...mediaIds].filter(id => !id.startsWith('staged:'));
  for (const chunk of chunks(shopMedia, 50)) { // eine Suche statt je Bild ein Abruf
    const r = await sw.search('media', { ids: chunk, limit: chunk.length }).catch(() => ({ data: [] as { id: string; url?: string }[] }));
    for (const id of chunk) media[id] = r.data.find(m => m.id === id)?.url ?? null;
  }
  for (const id of mediaIds) if (id.startsWith('staged:')) media[id] = `/staged/${stagedMeta(id.slice(7))?.file}`;
  return {
    products, product: spec.previewProductId ? products[spec.previewProductId] : undefined,
    imageUrl: (im: ImageRef) => (typeof im === 'string' ? im : im.url ?? media[im.mediaId ?? '']),
  };
}

const PUBLISH_DESCRIPTION = 'BEANTRAGT die Veröffentlichung des aktuellen Entwurfs (neues CMS-Layout + Zuweisung + Meta-Daten + vorgemerkte Bilder). Es wird nichts geschrieben, bis der Nutzer die Übersicht freigibt; der Aufruf wartet auf die Entscheidung. target: category (cmsType product_list), product (product_detail, productIds[]), landingpage (landingpage, url + salesChannelId).';

export const shopwarePages: PlatformPages = {
  previewData,

  async prepareDraft(session, input) {
    const reuseErrs = await resolveReuse(input, id => loadRawBlocks(session.sw, id)); // kopiert Quellblöcke in die Spec (bleibt im Entwurf für die Veröffentlichung)
    if (reuseErrs.length) return { spec: input, errors: reuseErrs };
    const { spec, report } = await prepareSpecLinks(session.sw, input); // technische Links → SEO-URL, Ziele prüfen
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
      categoryId: z.string().optional(), productIds: z.array(z.string()).optional(),
      url: z.string().optional().describe('Landingpage-URL-Pfad, z.B. "ratgeber/gartenduschen"'), salesChannelId: z.string().optional(),
      metaTitle: z.string().optional(), metaDescription: z.string().optional(),
    },
  },

  async buildPublish(session, spec, args) {
    const a = args as unknown as PublishArgs;
    if (a.target === 'category' && !a.categoryId) throw new Error('categoryId fehlt');
    if (a.target === 'product' && !a.productIds?.length) throw new Error('productIds fehlt');
    if (a.target === 'landingpage' && (!a.url || !a.salesChannelId)) throw new Error('url und salesChannelId fehlen');
    const { spec: fixed, report } = await prepareSpecLinks(session.sw, spec, a.target === 'landingpage' ? a.salesChannelId : undefined); // SEO-URLs aktuell halten
    const cs = await buildPublishChangeSet(session.sw, fixed, a);
    cs.items[0]?.warn.push(...(report?.findings ?? []).filter(f => f.level === 'wichtig').slice(0, 5).map(findingText));
    return { cs, payload: { spec: fixed, args: a } };
  },
};

import 'server-only';
// Shopify: Vorschau-Daten für Seitenentwürfe (echte Produkte, Bilder), Fokus der Oberfläche und publish_page
// (Landingpage = Online-Store-Seite, Kollektion/Produkt = Theme-Vorlage mit Lotse-Abschnitten; siehe publish.ts).
import { z } from 'zod';
import type { ChatEvent } from '@/lib/protocol';
import type { ImageRef, PageSpec, PreviewCtx, PreviewProduct } from '../../cms';
import { renderPageHtml, renderPageParts } from '../../page-html';
import { stagedMeta } from '../../media';
import type { Session } from '../../sessions';
import type { PlatformPages } from '../types';
import { shortId, type Json } from './client';
import { collectionsByIds, mediaByIds, productsByIds } from './data';
import { PREVIEW_SEL, previewProduct } from './preview';
import { buildShopifyPublish, type ShopifyPublishArgs } from './publish';
import { qOf, readerOf, shopOf } from './tools';

async function previewData(session: Session, spec: PageSpec): Promise<PreviewCtx> {
  const r = readerOf(session), q = qOf(r);
  const ids = new Set<string>(), mediaIds = new Set<string>();
  for (const s of spec.sections ?? []) for (const b of s.blocks ?? []) {
    (b.productIds ?? []).forEach(i => ids.add(String(i)));
    for (const k of ['image', 'image2'] as const) { const im = b[k]; if (typeof im === 'object' && im?.mediaId) mediaIds.add(im.mediaId); }
  }
  if (spec.previewProductId) ids.add(spec.previewProductId);
  if (spec.previewCategoryId) {
    const [c] = await collectionsByIds(q, [spec.previewCategoryId], 'id products(first: 12) { nodes { id status } }').catch(() => []);
    (c?.products?.nodes ?? []).filter((p: Json) => p.status === 'ACTIVE').slice(0, 8).forEach((p: Json) => ids.add(shortId(p.id)));
  }
  const valid = [...ids].filter(i => /^\d+$|^gid:\/\/shopify\/Product\//.test(i));
  const products: Record<string, PreviewProduct> = {};
  // Shop nicht erreichbar/eingerichtet: Vorschau ohne Produktdaten statt Fehler (der Entwurf selbst braucht den Shop nicht)
  if (valid.length) {
    const shop = await shopOf(r).catch(() => ({ currency: 'EUR', primaryUrl: '' }));
    for (const p of await productsByIds(q, valid, PREVIEW_SEL, 25).catch(() => [])) { const pp = previewProduct(p, shop.currency, shop.primaryUrl); products[pp.id!] = pp; products[p.id] = pp; }
  }
  const media: Record<string, string | null | undefined> = {};
  const shopMedia = [...mediaIds].filter(m => !m.startsWith('staged:') && /^\d+$|^gid:\/\/shopify\/MediaImage\//.test(m));
  if (shopMedia.length) for (const m of await mediaByIds(q, shopMedia).catch(() => [])) { media[shortId(m.id)] = m.image?.url; media[m.id] = m.image?.url; }
  for (const m of mediaIds) if (m.startsWith('staged:')) { const sm = stagedMeta(m.slice(7)); media[m] = sm ? `/staged/${sm.file}` : null; }
  return {
    products, product: spec.previewProductId ? products[spec.previewProductId] : undefined,
    imageUrl: (im: ImageRef) => (typeof im === 'string' ? im : im.url ?? media[im.mediaId ?? '']),
  };
}

export const shopifyPages: PlatformPages = {
  previewData,

  async focus(session, raw): Promise<ChatEvent | null> {
    const q = qOf(readerOf(session));
    if (raw.previewCategoryId) { const [c] = await collectionsByIds(q, [raw.previewCategoryId], 'id title handle').catch(() => []); if (c) return { t: 'focus', kind: 'category', id: shortId(c.id), name: c.title, path: `/collections/${c.handle}`, cmsPage: null }; }
    if (raw.previewProductId) { const [p] = await productsByIds(q, [raw.previewProductId], 'id title handle', 1).catch(() => []); if (p) return { t: 'focus', kind: 'product', id: shortId(p.id), name: p.title, path: `/products/${p.handle}`, cmsPage: null }; }
    return null;
  },

  publishTool: {
    description: 'BEANTRAGT die Veröffentlichung des aktuellen Entwurfs in Shopify (es wird nichts geschrieben, bis der Nutzer freigibt; der Aufruf wartet auf die Entscheidung). '
      + 'target landingpage (Entwurf landingpage): neue Online-Store-Seite unter /pages/<url> mit eigener Vollbreiten-Vorlage im Theme; url Pflicht, title optional (sonst Name des Entwurfs), published=false legt sie ausgeblendet an. '
      + 'target category (Entwurf product_list mit theme-main): Kollektion categoryId bekommt eine eigene Theme-Vorlage (Theme-Abschnitte bleiben, Lotse-Inhalt über/unter der Produktliste); mode "description" schreibt den Inhalt stattdessen als Kollektionsbeschreibung (wenn das Theme nicht beschreibbar ist). '
      + 'target product (Entwurf product_detail mit theme-main): productIds (1 bis 50) bekommen die Produktvorlage layout (Name, z. B. "keramik"). metaTitle/metaDescription für Seite bzw. Kollektion. Rückgängig stellt Vorlagen, Zuordnungen und Inhalte exakt wieder her.',
    shape: {
      target: z.enum(['landingpage', 'category', 'product']),
      url: z.string().optional().describe('Landingpage: Handle/Pfad, z. B. "ratgeber-vasen" → /pages/ratgeber-vasen'),
      title: z.string().optional().describe('Landingpage: Seitentitel im Shopify-Admin (Standard: Name des Entwurfs)'),
      published: z.boolean().optional().describe('Landingpage: sichtbar (Standard true)'),
      categoryId: z.string().optional().describe('Kollektion (target category)'),
      mode: z.enum(['theme', 'description']).optional().describe('category: theme (Standard) oder description'),
      productIds: z.array(z.string()).optional().describe('target product'),
      layout: z.string().optional().describe('target product: Name der Produktvorlage (Standard: Name des Entwurfs)'),
      metaTitle: z.string().optional(), metaDescription: z.string().optional(),
    },
  },
  async buildPublish(session, spec, args) {
    const r = readerOf(session), q = qOf(r), shop = await shopOf(r), ctx = await previewData(session, spec);
    const html = { imageUrl: (im: ImageRef) => ctx.imageUrl?.(im) ?? null, products: ctx.products as Record<string, PreviewProduct & { url?: string }>, scope: 'lotse-check' };
    return buildShopifyPublish(q, spec, args as unknown as ShopifyPublishArgs, {
      primaryUrl: shop.primaryUrl,
      render: s => (s.type === 'landingpage' ? { before: '', after: '', full: renderPageHtml(s, html) } : (() => { const x = renderPageParts(s, html); return { before: x.before, after: x.after, full: x.before + x.after }; })()),
    });
  },
};

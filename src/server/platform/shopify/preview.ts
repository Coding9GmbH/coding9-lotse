import 'server-only';
// Shopify: product → preview/page product (name, formatted price, image, link, FAQ). For preview (reader) and publishing (executor).
import type { PreviewProduct } from '../../cms';
import { shortId, type Json } from './client';
import { fmtMoney, toNum } from './data';

export const PREVIEW_SEL = 'id title handle onlineStoreUrl descriptionHtml status priceRangeV2 { minVariantPrice { amount currencyCode } maxVariantPrice { amount } } featuredMedia { ... on MediaImage { image { url altText } } } faq: metafield(namespace: "lotse", key: "faq") { value }';

/** Shopify product → preview product (name, formatted price, image, link, FAQ HTML) */
export function previewProduct(p: Json, currency: string, base: string): PreviewProduct & { url?: string } {
  const min = toNum(p.priceRangeV2?.minVariantPrice?.amount), max = toNum(p.priceRangeV2?.maxVariantPrice?.amount);
  let faqHtml: string | undefined; try { faqHtml = p.faq?.value ? JSON.parse(p.faq.value).html : undefined; } catch { /* not JSON */ }
  return { id: shortId(p.id), name: p.title, price: min == null ? null : `${max != null && max > min ? 'ab ' : ''}${fmtMoney(min, currency)}`, img: p.featuredMedia?.image?.url, description: p.descriptionHtml, faqHtml, url: p.onlineStoreUrl ?? (base ? `${base}/products/${p.handle}` : undefined) };
}

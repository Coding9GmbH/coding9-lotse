import 'server-only';
// Draft in the real theme (HTML platforms: Shopify, Magento, OpenMage): the shop's real target page (product, category/collection
// or home page as the frame of a landing page) keeps header, footer, theme CSS and its own content; the draft is inserted as exactly
// the HTML that publishing writes (renderPageParts/renderPageHtml). Counterpart to "draft on the real page" on Shopware (real-page.ts).
import { FRAME_CSS, FRAME_SCRIPT } from '@/lib/preview-frame';
import type { ImageRef, PageSpec, PreviewCtx } from './cms';
import { renderPageHtml, renderPageParts } from './page-html';
import type { PlatformAdapter } from './platform/types';
import { findDivByClass, injectIntoHead, stripScripts } from './real-page';
import { storefrontRewrite } from './runtime';
import type { Session } from './sessions';

const TTL = 60_000, MAX_BYTES = 1_500_000, HOPS = 2, SCOPE = 'lotse-preview';
const frames = new Map<string, { at: number; html: string | null }>();

/** Content area of a storefront page: <main> (Shopify, Magento 2) or .col-main (OpenMage rwd); null = not recognizable */
export function mainArea(html: string): { openEnd: number; close: number } | null {
  const open = /<main(?=[\s>])[^>]*>/i.exec(html); // not custom elements like <main-menu>
  if (open) { const close = html.indexOf('</main>', open.index + open[0].length); if (close > 0) return { openEnd: open.index + open[0].length, close }; }
  const col = findDivByClass(html, 'col-main');
  return col ? { openEnd: col.openEnd, close: col.end - '</div>'.length } : null;
}

/** Product description of Magento 2 (Luma: .product.attribute.description .value) or OpenMage (rwd: .box-description .std):
 *  there publishing writes the product content (replace mode). null = not found. */
export function descriptionArea(html: string): { openEnd: number; close: number } | null {
  for (const [outer, inner] of [['description', 'value'], ['box-description', 'std']] as const) {
    const o = findDivByClass(html, outer); if (!o) continue;
    const i = findDivByClass(html.slice(o.openEnd, o.end), inner); if (!i) continue;
    return { openEnd: o.openEnd + i.openEnd, close: o.openEnd + i.end - '</div>'.length };
  }
  return null;
}
/** Replace the product description with the draft (Magento/OpenMage product content); null = no description area */
export function spliceDescription(html: string, content: string): string | null {
  const d = descriptionArea(html);
  return d ? html.slice(0, d.openEnd) + `<div class="lotse-draft">${content}</div>` + html.slice(d.close) : null;
}

/** Shopify embeds theme assets protocol-relative (//shop/cdn/shop/t/…): to /shop as well, otherwise stripScripts would drop them as foreign */
export const rewriteProtocolRelative = (html: string, base: string) => {
  const host = new URL(base).host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return html.replace(new RegExp(`(["'(=\\s])//${host}(?=[/"'?#)])`, 'gi'), '$1/shop');
};

/**
 * Insert the draft into the page: replace = the whole content area (landing page), otherwise before at the start and after at the end
 * of the content area (above/below the theme content, e.g. product list or product area). null = no content area.
 */
export function spliceMain(html: string, parts: { before: string; after: string; replace: boolean }): string | null {
  const m = mainArea(html); if (!m) return null;
  const wrap = (h: string) => (h ? `<div class="lotse-draft">${h}</div>` : '');
  return parts.replace
    ? html.slice(0, m.openEnd) + wrap(parts.before + parts.after) + html.slice(m.close)
    : html.slice(0, m.openEnd) + wrap(parts.before) + html.slice(m.openEnd, m.close) + wrap(parts.after) + html.slice(m.close);
}

/** Storefront URL of the draft's target page: product, category/collection, otherwise the home page */
async function targetUrl(session: Session, p: PlatformAdapter, spec: PageSpec): Promise<string> {
  const base = (await p.storefront.base()).replace(/\/+$/, '');
  const ref = spec.type === 'product_detail' && spec.previewProductId ? { kind: 'product' as const, id: spec.previewProductId } : spec.type === 'product_list' && spec.previewCategoryId ? { kind: 'category' as const, id: spec.previewCategoryId } : null;
  if (!ref) return `${base}/`;
  const { urls, paths } = await session.lookup.entityPaths(ref.kind, ref.id);
  return urls[0] ?? (paths[0] ? `${base}/${paths[0]}` : `${base}/`);
}

/** The page's HTML with shop URLs rewritten to /shop and external scripts removed; cached briefly (each draft revision re-renders) */
async function frameHtml(session: Session, p: PlatformAdapter, url: string): Promise<string | null> {
  const hit = frames.get(url);
  if (hit && Date.now() - hit.at < TTL) return hit.html;
  let html: string | null = null;
  try {
    const base = (await p.storefront.base()).replace(/\/+$/, ''), origin = new URL(base).origin;
    let cur = url, r: Response | null = null;
    for (let hop = 0; hop <= HOPS; hop++) {
      r = await session.storefrontFetch(cur, { redirect: 'manual', headers: { accept: 'text/html', 'accept-language': 'de-DE,de' }, signal: AbortSignal.timeout(12_000) });
      const loc = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null;
      if (!loc) break;
      const next = new URL(loc, cur);
      if (next.origin !== origin) { r = null; break; } // only within the shop
      cur = next.href;
    }
    if (r?.ok && /text\/html/i.test(r.headers.get('content-type') ?? '')) {
      const text = await r.text();
      if (text.length <= MAX_BYTES) { const clean = stripScripts(rewriteProtocolRelative(storefrontRewrite(text, base), base)); if (mainArea(clean)) html = clean; }
    }
  } catch { html = null; }
  frames.set(url, { at: Date.now(), html });
  if (frames.size > 50) for (const k of frames.keys()) { frames.delete(k); if (frames.size <= 25) break; }
  return html;
}

/**
 * Preview of an HTML platform in the real theme. partial (streaming): only from the cache, no network.
 * null = not possible (target page unreachable, no content area, blocks not renderable as HTML): the caller renders the simple preview.
 */
export async function themePreview(session: Session, p: PlatformAdapter, spec: PageSpec, ctx: PreviewCtx, partial = false): Promise<string | null> {
  try {
    const url = await (partial ? Promise.resolve(lastUrl.get(session.id) ?? null) : targetUrl(session, p, spec));
    if (!url) return null;
    const frame = partial ? (frames.get(url)?.html ?? null) : await frameHtml(session, p, url);
    if (!frame) return null;
    lastUrl.set(session.id, url);
    if (lastUrl.size > 200) for (const k of lastUrl.keys()) { lastUrl.delete(k); if (lastUrl.size <= 100) break; }
    const hctx = { imageUrl: (im: ImageRef) => ctx.imageUrl?.(im) ?? (typeof im === 'string' ? im : im.url) ?? null, products: ctx.products, scope: SCOPE };
    let merged: string | null;
    if (spec.type === 'landingpage') merged = spliceMain(frame, { before: renderPageHtml(spec, hctx), after: '', replace: true });
    else {
      const parts = renderPageParts(spec, hctx);
      // Magento/OpenMage (no theme-main): product content is published into the product description, so it is shown there
      merged = (spec.type === 'product_detail' && !parts.themeMain ? spliceDescription(frame, parts.before + parts.after) : null) ?? spliceMain(frame, { ...parts, replace: false });
    }
    return merged ? injectIntoHead(merged, `<meta charset="utf-8"><style>${FRAME_CSS}</style><script>${FRAME_SCRIPT}</script>`) : null;
  } catch { return null; }
}
const lastUrl = new Map<string, string>();

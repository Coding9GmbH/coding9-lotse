import 'server-only';
// Read storefront pages of the own shop: text, images, links and (from the Shopware markup) the real structure of the
// Shopping Experience (sections → blocks → elements, plugin blocks too). Plus the mapping URL → CMS page via the SEO URLs.
import type { ShopReader, SwEntity } from './shopware';

export interface CmsBlockOutline { block: string; elements: string[] }
export interface CmsSectionOutline { section: string; blocks: CmsBlockOutline[] }
export interface PageOutline {
  title?: string; metaDescription?: string; canonical?: string;
  /** Page type per body classes: home page, category, product page, landing page, other */
  kind: string;
  headings: { level: number; text: string }[];
  text: string;
  images: { src: string; alt: string }[];
  links: { href: string; text: string }[];
  sections: CmsSectionOutline[];
  /** Block types in reading order (e.g. "text-hero", "acme-trust-bar") */
  blockSequence: string[];
  /** Common component classes (buttons, cards, badges …) */
  componentClasses: Record<string, number>;
}

const text = (html: string) => html.replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, '’').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const abs = (u: string, base: string) => { try { return new URL(u, base).href; } catch { return u; } };
const COMPONENT = /^(btn|btn-[a-z-]+|card|card-[a-z-]+|badge[a-z-]*|product-box|product-[a-z-]+|alert[a-z-]*|breadcrumb|accordion[a-z-]*|nav-tabs|carousel[a-z-]*|hero[a-z-]*|teaser[a-z-]*|cta[a-z-]*)$/;

export function pageKind(html: string): string {
  const body = html.match(/<body[^>]*class="([^"]*)"/i)?.[1] ?? '';
  if (/\bis-act-home\b/.test(body)) return 'Startseite';
  if (/\bis-ctl-product\b/.test(body)) return 'Produktseite';
  if (/\bis-ctl-navigation\b/.test(body)) return 'Kategorie';
  if (/\bis-ctl-landingpage\b/.test(body)) return 'Landingpage';
  return 'Sonstige';
}

/** Structure of the Shopping Experience from the rendered markup: the order of class attributes in the document yields the nesting. */
export function cmsOutline(html: string): { sections: CmsSectionOutline[]; componentClasses: Record<string, number> } {
  const sections: CmsSectionOutline[] = [];
  const comp: Record<string, number> = {};
  let section: CmsSectionOutline | null = null, block: CmsBlockOutline | null = null;
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    const tokens = m[1].split(/\s+/).filter(Boolean);
    for (const t of tokens) if (COMPONENT.test(t)) comp[t] = (comp[t] ?? 0) + 1;
    if (tokens.includes('cms-section')) { // Wrapper <div class="cms-section pos-0 cms-section-default">
      section = { section: tokens.map(t => t.match(/^cms-section-(?!pos)(.+)$/)?.[1]).find(Boolean) ?? 'default', blocks: [] };
      sections.push(section); block = null; continue;
    }
    if (tokens.includes('cms-block')) { // Wrapper <div class="cms-block pos-0 cms-block-text-hero">
      block = { block: tokens.map(t => t.match(/^cms-block-(?!pos|container)(.+)$/)?.[1]).find(Boolean) ?? 'unbekannt', elements: [] };
      if (!section) { section = { section: 'default', blocks: [] }; sections.push(section); }
      section.blocks.push(block); continue;
    }
    const els = tokens.map(t => t.match(/^cms-element-(?!pos)([a-z0-9-]+)$/)?.[1]).filter((x): x is string => !!x);
    if (els.length && block) block.elements.push(els.length > 1 ? `${els[0]} (${els[els.length - 1]})` : els[0]);
  }
  return { sections, componentClasses: Object.fromEntries(Object.entries(comp).sort((a, b) => b[1] - a[1]).slice(0, 30)) };
}

/** Readable summary of a storefront page (without header/footer area). */
export function parseStorefront(html: string, url: string, limits = { text: 6000, images: 20, links: 30, headings: 40 }): PageOutline {
  const title = text(html.match(/<title>([^<]*)/i)?.[1] ?? '') || undefined;
  const metaDescription = html.match(/<meta[^>]+name="description"[^>]+content="([^"]*)"/i)?.[1];
  const canonical = html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i)?.[1];
  const main = html.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? html.replace(/<(header|footer|nav)[\s\S]*?<\/\1>/gi, ' ');
  const headings = [...main.matchAll(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi)].map(m => ({ level: +m[1], text: text(m[2]) })).filter(h => h.text).slice(0, limits.headings);
  const images = [...main.matchAll(/<img\b[^>]*>/gi)].map(m => {
    const tag = m[0], src = tag.match(/\s(?:src|data-src)="([^"]+)"/i)?.[1];
    return src && !/^data:/.test(src) ? { src: abs(src, url), alt: text(tag.match(/\salt="([^"]*)"/i)?.[1] ?? '') } : null;
  }).filter((x): x is { src: string; alt: string } => !!x).filter((x, i, a) => a.findIndex(y => y.src === x.src) === i).slice(0, limits.images);
  const origin = (() => { try { return new URL(url).origin; } catch { return ''; } })();
  const seen = new Set<string>();
  const links = [...main.matchAll(/<a\b[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)].map(m => ({ href: abs(m[1], url), text: text(m[2]).slice(0, 80) }))
    .filter(l => l.href.startsWith(origin) && !/\.(jpe?g|png|webp|gif|svg|pdf)(\?|$)/i.test(l.href) && !seen.has(l.href) && seen.add(l.href)).slice(0, limits.links);
  const { sections, componentClasses } = cmsOutline(html);
  return {
    title, metaDescription, canonical, kind: pageKind(html), headings, text: text(main).slice(0, limits.text), images, links,
    sections, blockSequence: sections.flatMap(s => s.blocks.map(b => b.block)), componentClasses,
  };
}

export interface CmsTarget { kind: 'category' | 'product' | 'landingpage'; id: string; name?: string; cmsPage: { id: string; name?: string; type?: string } | null }

/** URL path → target (category/product/landing page) and its Shopping Experience, via SEO URLs or the technical paths. */
export async function resolveCmsTarget(sw: ShopReader, url: string): Promise<CmsTarget | null> {
  const raw = new URL(url).pathname.replace(/^\/+|\/+$/g, '');
  let path = raw; try { path = decodeURIComponent(raw); } catch { /* invalid encoding: raw value */ } // Shopware stores seoPathInfo decoded (umlauts), the browser copies it encoded
  let route: string | undefined, key: string | undefined, m: RegExpMatchArray | null;
  if ((m = path.match(/^navigation\/([0-9a-f]{32})$/))) [route, key] = ['frontend.navigation.page', m[1]];
  else if ((m = path.match(/^detail\/([0-9a-f]{32})$/))) [route, key] = ['frontend.detail.page', m[1]];
  else if ((m = path.match(/^landingPage\/([0-9a-f]{32})$/))) [route, key] = ['frontend.landing.page', m[1]];
  else {
    const r = await sw.search('seo-url', { limit: 5, filter: [{ type: 'equals', field: 'isCanonical', value: true }, { type: 'equalsAny', field: 'seoPathInfo', value: [...new Set([path, path + '/', raw, raw + '/'])] }] });
    const hit = r.data.find((s: SwEntity) => !s.isDeleted) ?? r.data[0];
    if (!hit) return null;
    route = hit.routeName; key = hit.foreignKey;
  }
  if (!route || !key) return null;
  const page = async (id: string | null | undefined) => { if (!id) return null; const p = await sw.get('cms-page', id); return p ? { id: p.id, name: p.name, type: p.type } : { id }; };
  if (route === 'frontend.navigation.page') { const c = await sw.get('category', key); return c ? { kind: 'category', id: c.id, name: c.translated?.name ?? c.name, cmsPage: await page(c.cmsPageId) } : null; }
  if (route === 'frontend.detail.page') { const p = await sw.get('product', key); return p ? { kind: 'product', id: p.id, name: p.translated?.name ?? p.name, cmsPage: await page(p.cmsPageId) } : null; }
  if (route === 'frontend.landing.page') { const l = await sw.get('landing-page', key); return l ? { kind: 'landingpage', id: l.id, name: l.translated?.name ?? l.name, cmsPage: await page(l.cmsPageId) } : null; }
  return null;
}

/** Only pages of the own shop (sales channel domains or API base); no free internet access for the AI. */
export function assertShopUrl(url: string, allowedOrigins: string[]): URL {
  let u: URL; try { u = new URL(url); } catch { throw new Error('Keine gültige URL.'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Nur http(s)-URLs.');
  if (u.username || u.password) throw new Error('URLs mit Benutzer oder Passwort sind nicht erlaubt.');
  const origins = new Set(allowedOrigins.map(o => { try { return new URL(o).origin; } catch { return ''; } }).filter(Boolean));
  if (!origins.has(u.origin)) throw new Error(`read_page liest nur Seiten des eigenen Shops (${[...origins].join(', ') || 'keine Domain konfiguriert'}). „${u.origin}“ gehört nicht dazu.`);
  return u;
}

const stripTrail = (s: string) => s.trim().replace(/\/+$/, '');

/**
 * Map the public shop URL onto the internal base (Docker: the browser knows https://shop/de, Lotse fetches http://172.17.0.2).
 * Only if the rest is empty or starts with /, ? or #. Otherwise the public URL stays: an appended @ or a
 * further host name must not turn the internal base into another host. Compose via origin + path, not via
 * `new URL(rest, basis)`; a rest `//fremd` would otherwise switch the host.
 */
export function mapPublicToInternal(publicUrl: string, internalBase: string, pageHref: string): string {
  const pub = stripTrail(publicUrl), baseRaw = stripTrail(internalBase);
  if (!pub || !baseRaw || pub === baseRaw || !pageHref.startsWith(pub)) return pageHref;
  const rest = pageHref.slice(pub.length);
  if (rest !== '' && rest[0] !== '/' && rest[0] !== '?' && rest[0] !== '#') return pageHref;
  let b: URL;
  try { b = new URL(baseRaw); } catch { return pageHref; }
  if (b.username || b.password || !/^https?:$/.test(b.protocol)) return pageHref;
  let out: URL;
  try { out = new URL(b.origin + b.pathname.replace(/\/+$/, '') + rest); } catch { return pageHref; }
  if (out.origin !== b.origin || out.username || out.password) return pageHref;
  return out.href;
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);

/**
 * Load a page of the own shop. The public address is mapped onto the internal base first.
 * Follow redirects manually (at most three): every target must again be an allowed shop address
 * and is mapped internally again before it is fetched.
 */
export async function fetchShopPage(pageHref: string, allowed: string[], opts: {
  publicUrl?: string; internalBase?: string;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  maxHops?: number;
} = {}): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch, max = opts.maxHops ?? 3;
  const pub = opts.publicUrl ?? '', internal = opts.internalBase ?? '';
  const place = (href: string) => (pub && internal ? mapPublicToInternal(pub, internal, href) : href);
  let cur = place(pageHref);
  assertShopUrl(cur, allowed);
  for (let hop = 0; ; hop++) {
    const r = await fetchImpl(cur, { redirect: 'manual' });
    if (!REDIRECT.has(r.status)) return r;
    const loc = r.headers.get('location');
    await r.body?.cancel().catch(() => {});
    if (!loc || hop >= max) throw new Error('Zu viele Weiterleitungen.');
    const next = new URL(loc, cur).href;
    assertShopUrl(next, allowed);
    cur = place(next);
    assertShopUrl(cur, allowed);
  }
}

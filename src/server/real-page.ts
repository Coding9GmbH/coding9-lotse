// Draft on the real page: the shop page's HTML (header, footer, theme, buy box, product list) stays, only the CMS content
// (.cms-sections) is replaced by the draft. Pure (no network): find parts, remove scripts, insert. Shopware markup.

const external = (url: string) => /^(?:https?:)?\/\//i.test(url.trim());
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*["']?([^"'\\s>]+)`, 'i'))?.[1];

/**
 * The shop's scripts stay (menu, slider, gallery run in the isolated preview); scripts and preload hints from foreign domains
 * (tracking, consent services) and comments are removed. The shop URL was rewritten to /shop beforehand, so shop scripts are relative.
 */
export function stripScripts(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b([^>]*)>[\s\S]*?<\/script\s*>/gi, (m, attrs: string) => { const src = attr(attrs, 'src'); return src && external(src) ? '' : m; })
    .replace(/<link\b[^>]*\brel=["']?(?:modulepreload|preload|prefetch)["']?[^>]*>/gi, m => { const href = attr(m, 'href'); return href && external(href) ? '' : m; });
}

const openDiv = () => /<div\b[^>]*>/gi; // a separate instance per call: otherwise nested searches share lastIndex
const hasClass = (attrs: string, cls: string) => {
  const m = attrs.match(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  return !!m && (m[1] ?? m[2]).split(/\s+/).includes(cls);
};

/** Index after the </div> that closes the <div> whose start tag ends at openEnd (nested divs counted); null = doesn't close */
function divEnd(html: string, openEnd: number): number | null {
  const tag = /<(\/?)div\b[^>]*>/gi;
  tag.lastIndex = openEnd;
  let depth = 1;
  for (let t: RegExpExecArray | null; (t = tag.exec(html)); ) {
    depth += t[1] ? -1 : 1;
    if (depth === 0) return t.index + t[0].length;
  }
  return null;
}

/** First <div> with the class; end = index after the matching </div> (nested divs counted). null if missing or not closed. */
export function findDivByClass(html: string, cls: string): { start: number; openEnd: number; end: number } | null {
  const re = openDiv();
  for (let m: RegExpExecArray | null; (m = re.exec(html)); ) {
    if (!hasClass(m[0], cls)) continue;
    const start = m.index, openEnd = start + m[0].length, end = divEnd(html, openEnd);
    return end == null ? null : { start, openEnd, end };
  }
  return null;
}

/** Replace the content of .cms-sections with sectionsHtml. null if the page has no CMS area (different theme, error page). */
export function spliceSections(html: string, sectionsHtml: string): string | null {
  const el = findDivByClass(html, 'cms-sections');
  if (!el) return null;
  const closeLen = '</div>'.length;
  return html.slice(0, el.openEnd) + sectionsHtml + html.slice(el.end - closeLen);
}

/** First CMS block (<div class="cms-block …">) whose markup contains the pattern; for themes with their own block types */
function findBlockContaining(html: string, marker: RegExp): { start: number; end: number } | null {
  const re = openDiv();
  for (let m: RegExpExecArray | null; (m = re.exec(html)); ) {
    if (!hasClass(m[0], 'cms-block')) continue;
    const end = divEnd(html, m.index + m[0].length);
    if (end != null && marker.test(html.slice(m.index, end))) return { start: m.index, end };
  }
  return null;
}

/** Dynamic blocks of the draft → possible CMS block types of the real page (default first, then common theme variants) */
export const REAL_BLOCK_TYPES: Record<string, string[]> = {
  'pdp-heading': ['product-heading'],
  'pdp-gallery-buybox': ['gallery-buybox', 'zen-gallery-heading-buybox', 'zen-gallery-buybox'],
  'pdp-description-reviews': ['product-description-reviews'],
  'pdp-cross-selling': ['cross-selling'],
  'product-listing': ['product-listing'],
  'sidebar-filter': ['sidebar-filter'],
};
/** Detection via the markup if the theme uses its own block types (buy box: default classes of the Storefront theme) */
const REAL_BLOCK_MARKERS: Record<string, RegExp> = { 'pdp-gallery-buybox': /product-detail-buy(?:-container|\b)|product-detail-buybox|buy-widget/ };

/**
 * Real blocks of the page per block type of the draft (e.g. the buy box). If a theme combines heading and buy box in one block,
 * that block replaces the buy box and the draft's heading is dropped (empty entry), so nothing appears twice.
 */
export function extractBlocks(html: string, byType: Record<string, string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [ours, types] of Object.entries(byType)) {
    let hit: { start: number; end: number } | null = null, used = '';
    for (const t of types) { const el = findDivByClass(html, `cms-block-${t}`); if (el) { hit = el; used = t; break; } }
    if (!hit && REAL_BLOCK_MARKERS[ours]) { hit = findBlockContaining(html, REAL_BLOCK_MARKERS[ours]); used = 'marker'; }
    if (hit) out[ours] = html.slice(hit.start, hit.end);
    if (hit && ours === 'pdp-gallery-buybox' && /heading/.test(used) && !('pdp-heading' in out)) out['pdp-heading'] = '';
  }
  return out;
}

/** Insert own styles and frame script before </head> (without <head>: at the start) */
export function injectIntoHead(html: string, headExtra: string): string {
  return /<\/head\s*>/i.test(html) ? html.replace(/<\/head\s*>/i, () => `${headExtra}</head>`) : headExtra + html; // function: don't evaluate $ patterns in the script
}

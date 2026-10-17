import 'server-only';
// Shared part of the storefront proxies (/shop for the live shop, /sbx/<task> for a task's sandbox): response headers (CSP, no-store,
// CORS for fonts/images), URL rewriting and the frame script for marking/scrolling. Fetching and redirect rules stay with each route.
import { FRAME_CSS, FRAME_SCRIPT } from '@/lib/preview-frame';
import { injectIntoHead } from './real-page';

export const NO_BODY = new Set([101, 204, 205, 304]);
/**
 * Shop HTML may run scripts (menu, slider, gallery), but never in Lotse's origin: `sandbox` without allow-same-origin makes the origin
 * opaque (also on direct navigation, not only in the iframe), no access to cookies, storage or the API. Scripts only from Lotse itself
 * (the proxy serves the shop's), no third parties. The frame script talks to the UI via postMessage (marking, scroll).
 */
export const HTML_CSP = "sandbox allow-scripts allow-forms; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'";
/**
 * Everything else (images, SVG, XML, XHTML, CSS, JSON, scripts, fonts): opened directly, a document without scripts and with an opaque origin;
 * otherwise an SVG with <script> from the shop media (/media/x.svg) would run in Lotse's origin and could call the API.
 * As a subresource (img, link, @font-face, script) the response's CSP does not apply, the preview loads it unchanged.
 */
export const ASSET_CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";
export const FRAME_HEAD = `<style>${FRAME_CSS}</style><script>${FRAME_SCRIPT}</script>`;

export const textResponse = (text: string, status: number, headers: Record<string, string> = {}) =>
  new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers } });

const mimeOf = (ct: string) => ct.split(';', 1)[0].trim().toLowerCase(); // MIME types are case-insensitive (TEXT/HTML)
/** Text bodies whose URLs are rewritten (HTML, CSS; with `allText` also JSON and JavaScript, e.g. the sandbox's ajax answers). */
export const rewritable = (ct: string, allText = false) => {
  const m = mimeOf(ct);
  return m === 'text/html' || m === 'text/css' || (allText && (m === 'application/json' || m.endsWith('+json') || m === 'text/javascript' || m === 'application/javascript'));
};

export interface RelayOpts {
  /** text body → rewritten text (HTML, CSS and whatever `rewritable(ct, allText)` lets through) */
  rewrite: (text: string, mime: string) => string;
  allText?: boolean;
  /** appended to the HTML CSP */
  extraCsp?: string;
  /** set on every answer (e.g. Referrer-Policy) */
  headers?: Record<string, string>;
}
/** Upstream answer → preview answer: only our own headers (never upstream cookies, X-Frame-Options or caching), rewritten text,
 *  frame script in HTML. Fonts and images with CORS allowed: the preview runs in an opaque origin, and the browser only loads
 *  @font-face with Access-Control-Allow-Origin. CSS, JSON and scripts stay without a wildcard. */
export async function relayResponse(r: Response, o: RelayOpts): Promise<Response> {
  const ct = r.headers.get('content-type') || 'application/octet-stream', mime = mimeOf(ct), html = mime === 'text/html';
  const corsAsset = mime.startsWith('image/') || mime.startsWith('font/') || mime === 'application/font-woff' || mime === 'application/font-woff2';
  const headers: Record<string, string> = {
    'content-type': ct, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'content-security-policy': html ? HTML_CSP + (o.extraCsp ? `; ${o.extraCsp}` : '') : ASSET_CSP,
    ...(corsAsset ? { 'access-control-allow-origin': '*' } : {}), ...o.headers,
  };
  if (NO_BODY.has(r.status)) return new Response(null, { status: r.status, headers });
  const body = html ? injectIntoHead(o.rewrite(await r.text(), mime), FRAME_HEAD) : rewritable(ct, o.allText) ? o.rewrite(await r.text(), mime) : await r.arrayBuffer();
  return new Response(body, { status: r.status, headers });
}

/** Origin of a storefront base (also JSON-escaped) → local prefix (/shop, /sbx/<task>). */
export function rewriteOrigin(txt: string, base: string, prefix: string): string {
  const variants: [string, string][] = [[base, prefix], [base.replace(/\//g, '\\/'), prefix.replace(/\//g, '\\/')]];
  return variants.reduce((t, [from, to]) => t.split(from).join(to), txt);
}

// Attributes that carry a URL; data-*-url etc. covers Shopware's ajax endpoints (data-url="/widgets/…")
const URL_ATTR = /(\s(?:href|src|action|formaction|poster|data(?:-[a-z0-9]+)*-(?:url|href|src|action)))(\s*=\s*)(["'])\/(?![/\\])/gi;
const SRCSET = /(\ssrcset\s*=\s*)(["'])([^"']*)\2/gi;
const CSS_URL = /(url\(\s*)(["']?)\/(?![/\\])/gi;
/** Root-relative URLs (/theme/…, /checkout/…) → prefix + path, in HTML attributes (also srcset) and CSS url().
 *  Paths already below the prefix and protocol-relative ones (//host) stay. Requests built by scripts are caught in proxy.ts via the Referer. */
export function rewriteRootRelative(txt: string, prefix: string, mime = 'text/html'): string {
  const p = prefix.replace(/\/$/, ''), bare = p.slice(1);
  /** the text at i (right after the leading "/") is already below the prefix */
  const inside = (all: string, i: number) => all.startsWith(bare, i) && /^(?:$|[/"'?#)\s])/.test(all.slice(i + bare.length, i + bare.length + 1));
  const css = (s: string) => s.replace(CSS_URL, (m, a: string, q: string, off: number, all: string) => (inside(all, off + m.length) ? m : `${a}${q}${p}/`));
  if (mime === 'text/css') return css(txt);
  return css(txt
    .replace(URL_ATTR, (m, a: string, eq: string, q: string, off: number, all: string) => (inside(all, off + m.length) ? m : `${a}${eq}${q}${p}/`))
    .replace(SRCSET, (_m, a: string, q: string, list: string) =>
      `${a}${q}${list.split(',').map(c => c.replace(/^(\s*)\/(?![/\\])/, (x, sp: string) => (inside(c, sp.length + 1) ? x : `${sp}${p}/`))).join(',')}${q}`));
}

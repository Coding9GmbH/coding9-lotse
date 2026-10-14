import type { NextRequest } from 'next/server';
import { STOREFRONT_PREFIX_HEADER, isStorefrontPathOf } from '@/lib/platforms';
import { errMsg } from '@/server/http';
import { activePlatform } from '@/server/platform';
import { FRAME_CSS, FRAME_SCRIPT } from '@/lib/preview-frame';
import { injectIntoHead } from '@/server/real-page';
import { storefrontRewrite } from '@/server/runtime';

export const dynamic = 'force-dynamic';

const NO_BODY = new Set([101, 204, 205, 304]);
/**
 * Shop HTML may run scripts (menu, slider, gallery), but never in Lotse's origin: `sandbox` without allow-same-origin makes the origin
 * opaque (also on direct navigation, not only in the iframe), no access to cookies, storage or the API. Scripts only from Lotse itself
 * (the proxy serves the shop's), no third parties. The frame script talks to the UI via postMessage (marking, scroll).
 */
const HTML_CSP = "sandbox allow-scripts allow-forms; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'";
/**
 * Everything else (images, SVG, XML, XHTML, CSS, JSON, scripts, fonts): opened directly, a document without scripts and with an opaque origin;
 * otherwise an SVG with <script> from the shop media (/media/x.svg) would run in Lotse's origin and could call the API.
 * As a subresource (img, link, @font-face, script) the response's CSP does not apply, the preview loads it unchanged.
 */
const ASSET_CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";
const FRAME_HEAD = `<style>${FRAME_CSS}</style><script>${FRAME_SCRIPT}</script>`;
const MAX_HOPS = 3;
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu']);
/** Same site: same host or same parent domain (stage.shop.de ↔ www.shop.de); excluding public suffixes like co.uk. */
function sameSite(a: string, c: string): boolean {
  const reg = (h: string) => {
    const l = h.toLowerCase().split('.');
    if (l.length < 2 || /^\d+$/.test(l[l.length - 1])) return h.toLowerCase(); // IP/localhost: exact match only
    const n = l.length >= 3 && l[l.length - 1].length === 2 && SECOND_LEVEL.has(l[l.length - 2]) ? 3 : 2;
    return l.slice(-n).join('.');
  };
  return a.toLowerCase() === c.toLowerCase() || (a.includes('.') && c.includes('.') && reg(a) === reg(c));
}

// Storefront proxy (storefront of the active platform): Shopware sends X-Frame-Options: deny → not embeddable directly. Here same origin, links rewritten to /shop.
// Paths without the /shop prefix also end up here (proxy.ts rewrites them).
export async function GET(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const url = (pathname.startsWith('/shop') ? pathname.slice(5) || '/' : pathname) + search;
  try {
    const platform = activePlatform();
    // Path without /shop redirected by proxy.ts: only prefixes of the active platform (the others are not storefront paths there)
    const prefix = req.headers.get(STOREFRONT_PREFIX_HEADER);
    if (prefix && !isStorefrontPathOf(platform.kind, prefix)) return new Response('Nicht gefunden', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    const sf = platform.storefront;
    const b = await sf.base();
    const hdrs = { accept: req.headers.get('accept') || '*/*', 'accept-language': 'de-DE,de' };
    let r = await sf.fetch(b + url, { redirect: 'manual', headers: hdrs });
    // Redirects: return same origin as the shop base as a /shop path; follow the same site on another subdomain
    // (stage.→www., media/CDN host) server-side. Everything else (foreign domain, credentials in the URL) is not followed.
    for (let hop = 0; ; hop++) {
      const loc = r.headers.get('location');
      if (!loc) break;
      let target: string | null = null, follow: string | null = null;
      try {
        const baseUrl = new URL(b);
        const abs = new URL(loc, hop === 0 ? baseUrl : r.url || baseUrl);
        if (!abs.username && !abs.password && /^https?:$/.test(abs.protocol)) {
          if (abs.origin === baseUrl.origin) target = storefrontRewrite(abs.href, b);
          else if (r.status < 400 && sameSite(abs.hostname, baseUrl.hostname) && hop < MAX_HOPS) follow = abs.href;
        }
      } catch { target = null; }
      if (follow) { r = await sf.fetch(follow, { redirect: 'manual', headers: hdrs }); continue; }
      if (!target) return new Response('Weiterleitung außerhalb des Shops', { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      return new Response(null, { status: r.status, headers: { location: target } });
    }
    const ct = r.headers.get('content-type') || 'application/octet-stream';
    // Preview only: no shop/third-party JS in Lotse's origin (in addition to the iframe sandbox without allow-scripts).
    // Fonts and images with CORS allowed: the draft runs in a sandboxed iframe with an opaque origin,
    // and the browser only loads @font-face with Access-Control-Allow-Origin. CSS, JSON and scripts stay without a wildcard.
    const mime = ct.split(';', 1)[0].trim().toLowerCase(), html = mime === 'text/html'; // MIME types are case-insensitive (TEXT/HTML)
    const corsAsset = mime.startsWith('image/') || mime.startsWith('font/') || mime === 'application/font-woff' || mime === 'application/font-woff2';
    const headers: Record<string, string> = { 'content-type': ct, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': html ? HTML_CSP : ASSET_CSP, ...(corsAsset ? { 'access-control-allow-origin': '*' } : {}) };
    if (NO_BODY.has(r.status)) return new Response(null, { status: r.status, headers });
    const body = html ? injectIntoHead(storefrontRewrite(await r.text(), b), FRAME_HEAD) : mime === 'text/css' ? storefrontRewrite(await r.text(), b) : await r.arrayBuffer();
    return new Response(body, { status: r.status, headers });
  } catch (e) {
    return new Response('Shop nicht erreichbar: ' + errMsg(e), { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
}

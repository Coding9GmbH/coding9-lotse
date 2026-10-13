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
 * Shop-HTML darf Skripte ausführen (Menü, Slider, Galerie), aber nie in Lotses Herkunft: `sandbox` ohne allow-same-origin macht den Origin
 * opak (auch bei direkter Navigation, nicht nur im iframe), kein Zugriff auf Cookies, Speicher oder die API. Skripte nur von Lotse selbst
 * (der Proxy liefert die des Shops), keine Drittanbieter. Der Rahmen-Skript spricht per postMessage mit der Oberfläche (Markieren, Scroll).
 */
const HTML_CSP = "sandbox allow-scripts allow-forms; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'";
const FRAME_HEAD = `<style>${FRAME_CSS}</style><script>${FRAME_SCRIPT}</script>`;
const MAX_HOPS = 3;
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu']);
/** Gleiche Site: gleicher Host oder gleiche Eltern-Domain (stage.shop.de ↔ www.shop.de); ohne öffentliche Suffixe wie co.uk. */
function sameSite(a: string, c: string): boolean {
  const reg = (h: string) => {
    const l = h.toLowerCase().split('.');
    if (l.length < 2 || /^\d+$/.test(l[l.length - 1])) return h.toLowerCase(); // IP/localhost: nur exakt
    const n = l.length >= 3 && l[l.length - 1].length === 2 && SECOND_LEVEL.has(l[l.length - 2]) ? 3 : 2;
    return l.slice(-n).join('.');
  };
  return a.toLowerCase() === c.toLowerCase() || (a.includes('.') && c.includes('.') && reg(a) === reg(c));
}

// Storefront-Proxy (Storefront der aktiven Plattform): Shopware sendet X-Frame-Options: deny → direkt nicht einbettbar. Hier gleiche Herkunft, Links auf /shop umgeschrieben.
// Auch die Pfade ohne /shop-Präfix landen hier (proxy.ts schreibt sie um).
export async function GET(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const url = (pathname.startsWith('/shop') ? pathname.slice(5) || '/' : pathname) + search;
  try {
    const platform = activePlatform();
    // Von proxy.ts umgeleiteter Pfad ohne /shop: nur Präfixe der aktiven Plattform (die anderen sind dort keine Storefront-Pfade)
    const prefix = req.headers.get(STOREFRONT_PREFIX_HEADER);
    if (prefix && !isStorefrontPathOf(platform.kind, prefix)) return new Response('Nicht gefunden', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    const sf = platform.storefront;
    const b = await sf.base();
    const hdrs = { accept: req.headers.get('accept') || '*/*', 'accept-language': 'de-DE,de' };
    let r = await sf.fetch(b + url, { redirect: 'manual', headers: hdrs });
    // Weiterleitungen: gleiche Herkunft wie die Shop-Basis als /shop-Pfad zurückgeben; derselbe Auftritt auf anderer Subdomain
    // (stage.→www., Medien-/CDN-Host) serverseitig folgen. Alles andere (fremde Domain, Zugangsdaten in der URL) wird nicht gefolgt.
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
    const html = /text\/html/.test(ct);
    // Nur Vorschau: kein Shop-/Drittanbieter-JS in Lotses Herkunft (zusätzlich zur iframe-Sandbox ohne allow-scripts).
    // Schriften und Bilder mit CORS-Freigabe: der Entwurf läuft in einem sandboxed iframe mit opakem Origin,
    // und @font-face lädt der Browser nur mit Access-Control-Allow-Origin. CSS, JSON und Skripte bleiben ohne Stern.
    const mime = ct.split(';', 1)[0].trim().toLowerCase();
    const corsAsset = mime.startsWith('image/') || mime.startsWith('font/') || mime === 'application/font-woff' || mime === 'application/font-woff2';
    const headers: Record<string, string> = { 'content-type': ct, 'cache-control': 'no-store', ...(html ? { 'content-security-policy': HTML_CSP } : {}), ...(corsAsset ? { 'access-control-allow-origin': '*' } : {}) };
    if (NO_BODY.has(r.status)) return new Response(null, { status: r.status, headers });
    const body = html ? injectIntoHead(storefrontRewrite(await r.text(), b), FRAME_HEAD) : /text\/css/.test(ct) ? storefrontRewrite(await r.text(), b) : await r.arrayBuffer();
    return new Response(body, { status: r.status, headers });
  } catch (e) {
    return new Response('Shop nicht erreichbar: ' + errMsg(e), { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
}

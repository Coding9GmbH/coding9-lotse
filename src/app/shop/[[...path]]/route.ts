import type { NextRequest } from 'next/server';
import { STOREFRONT_PREFIX_HEADER, isStorefrontPathOf } from '@/lib/platforms';
import { errMsg } from '@/server/http';
import { activePlatform } from '@/server/platform';
import { storefrontRewrite } from '@/server/runtime';

export const dynamic = 'force-dynamic';

const NO_BODY = new Set([101, 204, 205, 304]);

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
    const r = await sf.fetch(b + url, { redirect: 'manual', headers: { accept: req.headers.get('accept') || '*/*', 'accept-language': 'de-DE,de' } });
    const loc = r.headers.get('location');
    if (loc) {
      // Nur dieselbe Herkunft wie die Shop-Basis, ohne Zugangsdaten in der URL. Fremde Location nicht folgen und nicht durchreichen.
      let target: string | null = null;
      try {
        const baseUrl = new URL(b);
        const abs = new URL(loc, baseUrl);
        if (abs.origin === baseUrl.origin && !abs.username && !abs.password) target = storefrontRewrite(abs.href, b);
      } catch { target = null; }
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
    const headers: Record<string, string> = { 'content-type': ct, 'cache-control': 'no-store', ...(html ? { 'content-security-policy': "script-src 'none'" } : {}), ...(corsAsset ? { 'access-control-allow-origin': '*' } : {}) };
    if (NO_BODY.has(r.status)) return new Response(null, { status: r.status, headers });
    const body = /text\/(html|css)/.test(ct) ? storefrontRewrite(await r.text(), b) : await r.arrayBuffer();
    return new Response(body, { status: r.status, headers });
  } catch (e) {
    return new Response('Shop nicht erreichbar: ' + errMsg(e), { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
}

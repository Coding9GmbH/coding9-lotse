import type { NextRequest } from 'next/server';
import { STOREFRONT_PREFIX_HEADER, isStorefrontPathOf } from '@/lib/platforms';
import { errMsg } from '@/server/http';
import { trustedOrigins } from '@/server/media';
import { activePlatform } from '@/server/platform';
import { storefrontRewrite } from '@/server/runtime';
import { relayResponse, textResponse } from '@/server/storefront-proxy';

export const dynamic = 'force-dynamic';

const MAX_HOPS = 3;
/** Server-side redirect targets: only the shop's own addresses (settings URLs + sales channel domains) or the base host itself (http↔https).
 *  No eTLD+1 guess: on *.myshopify.com any sibling, on self-hosted shops e.g. internal.example.de would otherwise be fetched and proxied. */
const followable = (abs: URL, base: URL, trusted: Set<string>) => trusted.has(abs.origin) || (abs.hostname === base.hostname && abs.port === base.port);

// Storefront proxy (storefront of the active platform): Shopware sends X-Frame-Options: deny → not embeddable directly. Here same origin, links rewritten to /shop.
// Paths without the /shop prefix also end up here (proxy.ts rewrites them).
export async function GET(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const url = (pathname.startsWith('/shop') ? pathname.slice(5) || '/' : pathname) + search;
  try {
    const platform = activePlatform();
    // Path without /shop redirected by proxy.ts: only prefixes of the active platform (the others are not storefront paths there)
    const prefix = req.headers.get(STOREFRONT_PREFIX_HEADER);
    if (prefix && !isStorefrontPathOf(platform.kind, prefix)) return textResponse('Nicht gefunden', 404);
    const sf = platform.storefront;
    const b = await sf.base();
    const hdrs = { accept: req.headers.get('accept') || '*/*', 'accept-language': 'de-DE,de' };
    let r = await sf.fetch(b + url, { redirect: 'manual', headers: hdrs });
    // Redirects: return same origin as the shop base as a /shop path; follow the shop's other trusted addresses
    // (stage.→www. as a sales channel domain) server-side. Everything else (foreign/sibling domain, credentials in the URL) is not followed.
    let trusted: Set<string> | null = null;
    for (let hop = 0; ; hop++) {
      const loc = r.headers.get('location');
      if (!loc) break;
      let target: string | null = null, follow: string | null = null;
      try {
        const baseUrl = new URL(b);
        const abs = new URL(loc, hop === 0 ? baseUrl : r.url || baseUrl);
        if (!abs.username && !abs.password && /^https?:$/.test(abs.protocol)) {
          if (abs.origin === baseUrl.origin) target = storefrontRewrite(abs.href, b);
          else if (r.status < 400 && hop < MAX_HOPS && followable(abs, baseUrl, trusted ??= await trustedOrigins())) follow = abs.href;
        }
      } catch { target = null; }
      if (follow) { r = await sf.fetch(follow, { redirect: 'manual', headers: hdrs }); continue; }
      if (!target) return textResponse('Weiterleitung außerhalb des Shops', 502);
      return new Response(null, { status: r.status, headers: { location: target } });
    }
    // Preview only: no shop/third-party JS in Lotse's origin (in addition to the iframe sandbox without allow-scripts)
    return await relayResponse(r, { rewrite: text => storefrontRewrite(text, b) });
  } catch (e) {
    return textResponse('Shop nicht erreichbar: ' + errMsg(e), 502);
  }
}

import 'server-only';
// Privileged Shopware client (the only writer, never given to the AI) + storefront base/theme CSS cache.
import { setFetcher, setImageConfig, setTrustedOrigins } from './media';
import { getSettings } from './settings';
import { Shopware, type SwEntity } from './shopware';
import { singleton } from './state';
import { rewriteOrigin } from './storefront-proxy';

interface Runtime { sw: Shopware; sfBase: string | null; themeCssP: Promise<string | null> | null; themeCssAt: number }

const rt = () => singleton<Runtime>('runtime', () => {
  const r: Runtime = { sw: new Shopware(getSettings().shopware), sfBase: null, themeCssP: null, themeCssAt: 0 };
  configureMedia(r.sw);
  return r;
});
function configureMedia(sw: Shopware) {
  const g = getSettings();
  setImageConfig({ key: g.image.openaiKey, model: g.image.model }); setFetcher((u, i) => sw.storefrontFetch(u, i));
  // Sales channel domains count as the own shop (image download may reach internal Docker addresses there, cloud metadata/link-local never; see media.ts)
  setTrustedOrigins(async () => (getSettings().platform !== 'shopware' ? [] : (await sw.salesChannels().catch(() => [] as SwEntity[])).flatMap(c => (c.domains ?? []).map((d: SwEntity) => String(d.url)))));
}

/** Privileged client: stays in the server, is NEVER given to the AI. */
export const shop = () => rt().sw;

// Reconfigure after the settings change
export function applyRuntime() {
  const r = rt(), g = getSettings();
  r.sw.configure(g.shopware); r.sfBase = null; r.sw.sfDomain = null; r.themeCssP = null;
  configureMedia(r.sw);
}

export const storefrontFetch = (u: string, i?: RequestInit) => shop().storefrontFetch(u, i);

// ---- Storefront proxy (Shopware sends X-Frame-Options: deny → can't be embedded directly) ----
const STOREFRONT_TYPE = '8a243080f92e4c719546314b577cf82b';
export async function storefrontBase(): Promise<string> {
  const r = rt();
  if (!r.sfBase) {
    // active storefront channel first (not a headless/API channel or an inactive one that happens to come first)
    const withDomain = (await r.sw.salesChannels()).filter(c => c.domains?.length);
    const c = withDomain.find(c => c.typeId === STOREFRONT_TYPE && c.active !== false) ?? withDomain.find(c => c.typeId === STOREFRONT_TYPE) ?? withDomain[0];
    r.sfBase = (c?.domains[0].url ?? r.sw.publicUrl).replace(/\/$/, ''); r.sw.sfDomain = r.sfBase;
  }
  return r.sfBase!;
}
/** Replaces the storefront base URL (also JSON-escaped) with the local prefix (/shop, or /sbx/<task> for a sandbox). */
export const storefrontRewrite = (txt: string, b: string, prefix = '/shop') => rewriteOrigin(txt, b, prefix);

export function themeCss(): Promise<string | null> {
  const r = rt();
  if (!r.themeCssP || Date.now() - r.themeCssAt > 300_000) {
    r.themeCssAt = Date.now();
    r.themeCssP = (async () => { try { const b = await storefrontBase(); const html = await (await r.sw.storefrontFetch(b + '/')).text(); const h = html.match(/<link[^>]+href="([^"]+\/theme\/[^"]+\.css[^"]*)"/i)?.[1]; return h ? storefrontRewrite(h, b) : null; } catch { return null; } })();
  }
  return r.themeCssP;
}

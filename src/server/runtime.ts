import 'server-only';
// Privilegierter Shopware-Client (einziger Schreiber, nie bei der KI) + Storefront-Basis/Theme-CSS-Cache.
import { setFetcher, setImageConfig, setTrustedOrigins } from './media';
import { getSettings } from './settings';
import { Shopware, type SwEntity } from './shopware';
import { singleton } from './state';

interface Runtime { sw: Shopware; sfBase: string | null; themeCssP: Promise<string | null> | null; themeCssAt: number }

const rt = () => singleton<Runtime>('runtime', () => {
  const r: Runtime = { sw: new Shopware(getSettings().shopware), sfBase: null, themeCssP: null, themeCssAt: 0 };
  configureMedia(r.sw);
  return r;
});
function configureMedia(sw: Shopware) {
  const g = getSettings();
  setImageConfig({ key: g.image.openaiKey, model: g.image.model }); setFetcher((u, i) => sw.storefrontFetch(u, i));
  // Domains der Verkaufskanäle gelten als eigener Shop (dort darf der Bild-Download auch interne Adressen erreichen)
  setTrustedOrigins(async () => (getSettings().platform !== 'shopware' ? [] : (await sw.salesChannels().catch(() => [] as SwEntity[])).flatMap(c => (c.domains ?? []).map((d: SwEntity) => String(d.url)))));
}

/** Privilegierter Client: bleibt im Server, wird NIE an die KI gegeben. */
export const shop = () => rt().sw;

// Nach Änderung der Einstellungen neu konfigurieren
export function applyRuntime() {
  const r = rt(), g = getSettings();
  r.sw.configure(g.shopware); r.sfBase = null; r.sw.sfDomain = null; r.themeCssP = null;
  configureMedia(r.sw);
}

export const storefrontFetch = (u: string, i?: RequestInit) => shop().storefrontFetch(u, i);

// ---- Storefront-Proxy (Shopware sendet X-Frame-Options: deny → direkt nicht einbettbar) ----
const STOREFRONT_TYPE = '8a243080f92e4c719546314b577cf82b';
export async function storefrontBase(): Promise<string> {
  const r = rt();
  if (!r.sfBase) {
    // aktiver Storefront-Kanal zuerst (nicht ein Headless-/API-Kanal oder ein inaktiver, der zufällig vorn steht)
    const withDomain = (await r.sw.salesChannels()).filter(c => c.domains?.length);
    const c = withDomain.find(c => c.typeId === STOREFRONT_TYPE && c.active !== false) ?? withDomain.find(c => c.typeId === STOREFRONT_TYPE) ?? withDomain[0];
    r.sfBase = (c?.domains[0].url ?? r.sw.publicUrl).replace(/\/$/, ''); r.sw.sfDomain = r.sfBase;
  }
  return r.sfBase!;
}
const hostVariants = (b: string) => [b, b.replace(/\//g, '\\/')];
/** Ersetzt die Storefront-Basis-URL (auch JSON-escaped) durch den lokalen Präfix /shop. */
export const storefrontRewrite = (txt: string, b: string) => hostVariants(b).reduce((t, v) => t.split(v).join(v.includes('\\') ? '\\/shop' : '/shop'), txt);

export function themeCss(): Promise<string | null> {
  const r = rt();
  if (!r.themeCssP || Date.now() - r.themeCssAt > 300_000) {
    r.themeCssAt = Date.now();
    r.themeCssP = (async () => { try { const b = await storefrontBase(); const html = await (await r.sw.storefrontFetch(b + '/')).text(); const h = html.match(/<link[^>]+href="([^"]+\/theme\/[^"]+\.css[^"]*)"/i)?.[1]; return h ? storefrontRewrite(h, b) : null; } catch { return null; } })();
  }
  return r.themeCssP;
}

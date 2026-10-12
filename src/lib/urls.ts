import type { AppConfig, PlatformPaths, Target } from './protocol';

type Cfg = Pick<AppConfig, 'admin' | 'storefront' | 'paths'>;

/** Shopware-Pfade (Standard, solange /api/config noch keine Pfade der Plattform geliefert hat) */
export const SHOPWARE_PATHS: PlatformPaths = { adminCategory: '/admin#/sw/category/index/{id}', adminProduct: '/admin#/sw/product/detail/{id}/base', adminCms: '/admin#/sw/cms/detail/{id}', category: '/navigation/{id}', product: '/detail/{id}' };
const fill = (tpl: string, id: string) => tpl.split('{id}').join(id);

export const adminUrl = (cfg: Cfg, kind: 'category' | 'product' | 'cms', id: string): string => {
  const p = cfg.paths ?? SHOPWARE_PATHS;
  return cfg.admin + fill(kind === 'category' ? p.adminCategory : kind === 'product' ? p.adminProduct : p.adminCms, id);
};

export const storefrontUrl = (cfg: Cfg, t: Target): string => {
  const p = cfg.paths ?? SHOPWARE_PATHS;
  return cfg.storefront + fill(t.kind === 'category' ? p.category : p.product, t.id ?? '');
};

/** Echte Shop-Seite über den lokalen Proxy (/shop/…), damit sie im iframe angezeigt werden darf. */
export function liveSrc(target: Target | null, override: string | null, paths: PlatformPaths = SHOPWARE_PATHS): string | null {
  if (override) return override;
  if (!target?.id || target.kind === 'landing') return null;
  return '/shop' + fill(target.kind === 'category' ? paths.category : paths.product, target.id);
}

/** Cache-Buster nach einer Veröffentlichung anhängen. */
export const withBust = (url: string, bust: number): string => (bust ? `${url}${url.includes('?') ? '&' : '?'}t=${bust}` : url);

/** storefront kann ein String oder eine Liste sein (Produktseiten: mehrere). */
export const asList = (v: unknown): string[] =>
  (Array.isArray(v) ? v : v == null ? [] : [v]).filter((x): x is string => typeof x === 'string' && x.length > 0);

/** Absolute Storefront-URL → Proxy-Pfad (/shop/…). */
export function shopProxyPath(url: string | undefined): string | null {
  if (!url) return null;
  try { return '/shop' + new URL(url).pathname; } catch { return null; }
}

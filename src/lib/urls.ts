import type { AppConfig, PlatformPaths, Target } from './protocol';

type Cfg = Pick<AppConfig, 'admin' | 'storefront' | 'paths'>;

/** Shopware paths (default until /api/config has delivered the platform's paths) */
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

/** Real shop page via the local proxy (/shop/…) so it may be shown in the iframe. */
export function liveSrc(target: Target | null, override: string | null, paths: PlatformPaths = SHOPWARE_PATHS): string | null {
  if (override) return override;
  if (!target?.id || target.kind === 'landing') return null;
  return '/shop' + fill(target.kind === 'category' ? paths.category : paths.product, target.id);
}

/** Append a cache buster after publishing. */
export const withBust = (url: string, bust: number): string => (bust ? `${url}${url.includes('?') ? '&' : '?'}t=${bust}` : url);

/** storefront can be a string or a list (product pages: several). */
export const asList = (v: unknown): string[] =>
  (Array.isArray(v) ? v : v == null ? [] : [v]).filter((x): x is string => typeof x === 'string' && x.length > 0);

/** Absolute storefront URL → proxy path (/shop/…). */
export function shopProxyPath(url: string | undefined): string | null {
  if (!url) return null;
  try { return '/shop' + new URL(url).pathname; } catch { return null; }
}

// ---- Sandbox preview (/sbx/<task id>.<key>/…) ----
/** Prefix of a preview path: the segment is the task id plus its key (see server/sandbox/tasks.previewPath) */
export const SANDBOX_PATH = /^\/sbx\/(t_[a-z0-9]{12}\.[a-f0-9]{20})(?=\/|$)/;
/** URL of a path in a task's storefront preview: always below the task's prefix, whatever is typed (no host, no "//", no "..") */
export function sandboxSrc(prefix: string, path = '/'): string {
  let p = path.trim();
  try { if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('//')) { const u = new URL(p, 'http://x'); p = u.pathname + u.search + u.hash; } } catch { p = '/'; }
  p = `/${p.replace(/^\/+/, '')}`.replace(/\/\.\.?(?=\/|$|\?|#)/g, '');
  return `${prefix.replace(/\/$/, '')}${p || '/'}`;
}
/** Preview segment (<id>.<key>) of a Referer on the same host whose path is below /sbx/<segment>/, otherwise null. */
export function sandboxReferer(referer: string | null, host: string): string | null {
  if (!referer) return null;
  try { const u = new URL(referer); return u.host === host ? u.pathname.match(SANDBOX_PATH)?.[1] ?? null : null; } catch { return null; }
}

// Shop platforms (Shopware 6, Shopify, Magento 2, OpenMage): ID, name and credential fields for the settings.
// Pure data + helpers, shared by server (settings.ts, platform/*) and UI (SettingsView).
// The adapters themselves live under src/server/platform/<kind>/ (see docs/platform.md).
// Texts (field names, hints) live per language in i18n/messages/lib.ts (imported directly: proxy.ts loads this file too).
import { DEFAULT_LOCALE, type Locale } from './i18n/locales';
import { de as deLib, en as enLib } from './i18n/messages/lib';

const LIB: Record<Locale, typeof deLib> = { de: deLib, en: enLib };

export type PlatformKind = 'shopware' | 'shopify' | 'magento' | 'openmage';
export const PLATFORM_KINDS: readonly PlatformKind[] = ['shopware', 'shopify', 'magento', 'openmage'];
export const DEFAULT_PLATFORM: PlatformKind = 'shopware';
export const isPlatformKind = (v: unknown): v is PlatformKind => typeof v === 'string' && (PLATFORM_KINDS as readonly string[]).includes(v);

/** An input field of the shop connection. secret = stored encrypted, never shown and never passed to the AI. */
export interface PlatformField {
  key: string;
  label: string;
  secret?: boolean;
  /** url = address (type="url"), text = other plain text */
  type?: 'url' | 'text';
  placeholder?: string;
  /** Help text below the field; **bold** is highlighted */
  hint?: string;
  /** Environment variable as fallback when nothing is stored (e.g. SHOPWARE_URL) */
  env?: string;
  /** optional = not required for "configured" */
  optional?: boolean;
  autoComplete?: string;
  /** Select list instead of free text (value '' = not set) */
  options?: { value: string; label: string }[];
}
/** Alternative access methods (e.g. integration or admin user). Configured as soon as ONE method is complete. */
export interface PlatformAuthMode { key: string; label: string; hint?: string; fields: PlatformField[] }
export interface PlatformSettingsDescriptor {
  kind: PlatformKind;
  /** Display name, e.g. "Shopware" */
  label: string;
  /** Long form for texts, e.g. "Shopware 6" */
  product: string;
  /** general fields (URL ...) */
  fields: PlatformField[];
  /** Access methods; the first is the default */
  auth: PlatformAuthMode[];
  /** Label of the access method picker, if there are several */
  authLabel?: string;
  /**
   * Path prefixes the storefront requests without the /shop prefix (assets, widgets, links). proxy.ts forwards them to the
   * preview proxy /shop, otherwise the live preview breaks. Only the first segment or a fixed segment sequence, without outer slashes.
   */
  storefrontPaths: readonly string[];
  /** Name of categories in the UI (Shopify: collection), default category */
  categoryNoun?: { one: string; many: string };
  /** Adapter fully connected. false = preview: credentials can be saved, tools report "not available yet". */
  available: boolean;
  /** Alpha: connected but not yet proven in daily use with real shops (unlike Shopware). The UI marks this. */
  alpha?: boolean;
}

type PlatformTexts = typeof deLib.platforms;

/** Description of a platform with the texts of one language (structure, environment variables and paths are language-independent). */
const DESCRIBE: Record<PlatformKind, (t: PlatformTexts) => PlatformSettingsDescriptor> = {
  shopware: ({ urlPlaceholder, authLabel, shopware: x }) => ({
    kind: 'shopware', label: 'Shopware', product: 'Shopware 6', available: true,
    storefrontPaths: ['widgets', 'checkout', 'account', 'navigation', 'detail', 'search', 'bundles', 'theme', 'media', 'thumbnail', 'store-api'],
    fields: [
      { key: 'url', label: x.url.label, type: 'url', placeholder: urlPlaceholder, hint: x.url.hint, env: 'SHOPWARE_URL', autoComplete: 'url' },
      { key: 'publicUrl', label: x.publicUrl.label, type: 'url', placeholder: urlPlaceholder, hint: x.publicUrl.hint, env: 'SHOPWARE_PUBLIC_URL', optional: true },
    ],
    authLabel,
    auth: [
      { key: 'integration', label: x.integration.label, hint: x.integration.hint,
        fields: [
          { key: 'clientId', label: x.clientId, placeholder: 'SWIA…', env: 'SHOPWARE_CLIENT_ID', autoComplete: 'off' },
          { key: 'clientSecret', label: x.clientSecret, secret: true, env: 'SHOPWARE_CLIENT_SECRET' },
        ] },
      { key: 'user', label: x.userMode.label, hint: x.userMode.hint,
        fields: [
          { key: 'user', label: x.user, env: 'SHOPWARE_USER', autoComplete: 'username' },
          { key: 'password', label: x.password, secret: true, env: 'SHOPWARE_PASSWORD', autoComplete: 'current-password' },
        ] },
    ],
  }),
  shopify: ({ urlPlaceholder, authLabel, shopify: x }) => ({
    kind: 'shopify', label: 'Shopify', product: 'Shopify', available: true, alpha: true, categoryNoun: x.category,
    storefrontPaths: ['cdn', 'products', 'collections', 'pages', 'cart', 'search'],
    fields: [
      { key: 'storeDomain', label: x.storeDomain.label, placeholder: x.storeDomain.placeholder, hint: x.storeDomain.hint, env: 'SHOPIFY_STORE_DOMAIN', autoComplete: 'off' },
      { key: 'publicUrl', label: x.publicUrl.label, type: 'url', placeholder: urlPlaceholder, hint: x.publicUrl.hint, env: 'SHOPIFY_PUBLIC_URL', optional: true },
      { key: 'apiVersion', label: x.apiVersion.label, placeholder: '2026-10', hint: x.apiVersion.hint, env: 'SHOPIFY_API_VERSION', optional: true },
    ],
    authLabel,
    auth: [
      { key: 'app', label: x.app.label, hint: x.app.hint,
        fields: [
          { key: 'clientId', label: x.clientId, env: 'SHOPIFY_CLIENT_ID', autoComplete: 'off' },
          { key: 'clientSecret', label: x.clientSecret, secret: true, env: 'SHOPIFY_CLIENT_SECRET' },
        ] },
      { key: 'token', label: x.token.label, hint: x.token.hint,
        fields: [{ key: 'accessToken', label: x.accessToken, secret: true, placeholder: 'shpat_…', env: 'SHOPIFY_ACCESS_TOKEN' }] },
    ],
  }),
  magento: ({ urlPlaceholder, authLabel, magento: x }) => ({
    kind: 'magento', label: 'Magento', product: 'Magento 2 (Adobe Commerce)', available: true, alpha: true,
    storefrontPaths: ['static', 'media', 'pub', 'catalog', 'checkout', 'customer/section'],
    fields: [
      { key: 'url', label: x.url.label, type: 'url', placeholder: urlPlaceholder, hint: x.url.hint, env: 'MAGENTO_URL', autoComplete: 'url' },
      { key: 'publicUrl', label: x.publicUrl.label, type: 'url', placeholder: urlPlaceholder, hint: x.publicUrl.hint, env: 'MAGENTO_PUBLIC_URL', optional: true },
      { key: 'storeCode', label: x.storeCode.label, placeholder: 'default', hint: x.storeCode.hint, env: 'MAGENTO_STORE_CODE', optional: true },
      { key: 'priceBasis', label: x.priceBasis.label, env: 'MAGENTO_PRICE_BASIS', optional: true,
        options: [{ value: '', label: x.priceBasisOptions.none }, { value: 'gross', label: x.priceBasisOptions.gross }, { value: 'net', label: x.priceBasisOptions.net }],
        hint: x.priceBasis.hint },
    ],
    authLabel,
    auth: [
      { key: 'integration', label: x.integration.label, hint: x.integration.hint,
        fields: [{ key: 'accessToken', label: x.accessToken, secret: true, env: 'MAGENTO_ACCESS_TOKEN' }] },
      { key: 'user', label: x.userMode.label, hint: x.userMode.hint,
        fields: [
          { key: 'user', label: x.user, env: 'MAGENTO_USER', autoComplete: 'username' },
          { key: 'password', label: x.password, secret: true, env: 'MAGENTO_PASSWORD', autoComplete: 'current-password' },
        ] },
    ],
  }),
  openmage: ({ urlPlaceholder, openmage: x }) => ({
    kind: 'openmage', label: 'OpenMage', product: 'OpenMage (Magento 1)', available: true, alpha: true,
    storefrontPaths: ['skin', 'js', 'media', 'catalog', 'catalogsearch', 'checkout', 'cms', 'index.php'],
    fields: [
      { key: 'url', label: x.url.label, type: 'url', placeholder: urlPlaceholder, hint: x.url.hint, env: 'OPENMAGE_URL', autoComplete: 'url' },
      { key: 'publicUrl', label: x.publicUrl.label, type: 'url', placeholder: urlPlaceholder, hint: x.publicUrl.hint, env: 'OPENMAGE_PUBLIC_URL', optional: true },
      { key: 'storeCode', label: x.storeCode.label, placeholder: 'default', hint: x.storeCode.hint, env: 'OPENMAGE_STORE_CODE', optional: true },
    ],
    auth: [
      { key: 'token', label: x.token.label, hint: x.token.hint,
        fields: [{ key: 'token', label: x.tokenField, secret: true, placeholder: 'lotse_…', env: 'OPENMAGE_TOKEN' }] },
    ],
  }),
};

const describeAll = (t: PlatformTexts) => Object.fromEntries(PLATFORM_KINDS.map(k => [k, DESCRIBE[k](t)])) as Record<PlatformKind, PlatformSettingsDescriptor>;
/** Platforms with German texts (server, adapters); for the UI per language: platformSettings(kind, locale). */
export const PLATFORM_SETTINGS: Record<PlatformKind, PlatformSettingsDescriptor> = describeAll(deLib.platforms);
const BY_LOCALE: Partial<Record<Locale, Record<PlatformKind, PlatformSettingsDescriptor>>> = { [DEFAULT_LOCALE]: PLATFORM_SETTINGS };
/** Description of a platform with field names, hints and placeholders in the requested language. */
export function platformSettings(kind: PlatformKind, locale: Locale = DEFAULT_LOCALE): PlatformSettingsDescriptor {
  const all = BY_LOCALE[locale] ??= describeAll(LIB[locale]?.platforms ?? deLib.platforms);
  return all[kind];
}
/** Name of categories in the UI (Shopify: collection), otherwise category */
export const categoryNoun = (kind: PlatformKind | null | undefined, locale: Locale = DEFAULT_LOCALE): { one: string; many: string } =>
  (kind && platformSettings(kind, locale).categoryNoun) || (LIB[locale] ?? deLib).platforms.category;

/** Escape regex metacharacters (for RegExp sources, also RE2 filters such as Search Console) */
export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ALL_STOREFRONT_PATHS = [...new Set(PLATFORM_KINDS.flatMap(k => PLATFORM_SETTINGS[k].storefrontPaths))].sort((a, b) => b.length - a.length);
const STOREFRONT_RE = new RegExp(`^/(${ALL_STOREFRONT_PATHS.map(escapeRe).join('|')})(/|$)`);
/**
 * Storefront prefix of a path without /shop (union of all platforms; proxy.ts doesn't know the active platform),
 * e.g. '/cdn/shop/x.css' → 'cdn'. null = not a storefront path. Whether the prefix belongs to the active platform is checked by the /shop route.
 */
export const storefrontPrefix = (pathname: string): string | null => STOREFRONT_RE.exec(pathname)?.[1] ?? null;
/** Header with which proxy.ts passes the redirected prefix to the /shop route */
export const STOREFRONT_PREFIX_HEADER = 'x-lotse-storefront-prefix';
export const isStorefrontPathOf = (kind: PlatformKind, prefix: string) => PLATFORM_SETTINGS[kind].storefrontPaths.includes(prefix);

/** Visible section name. Shopware keeps Shopping Experiences; the other platforms don't. German: info from the server remains the basis. */
export function scopeDisplay(kind: PlatformKind, key: string, info: { label: string; hint: string }, locale: Locale = DEFAULT_LOCALE): { label: string; hint: string } {
  const t = (LIB[locale] ?? deLib).scopes, base = locale === DEFAULT_LOCALE ? info : (t.base as Record<string, { label: string; hint: string }>)[key] ?? info;
  if (kind === 'shopware') return base;
  return (t[kind] as Record<string, { label: string; hint: string } | undefined>)[key] ?? (locale === DEFAULT_LOCALE ? {
    label: info.label.replace(/Einkaufswelten-Layouts/g, 'Seiten'),
    hint: info.hint.replace(/Produktstreams/g, 'Gruppen').replace(/Verkaufskanäle(?: & Domains)?/g, 'Vertrieb'),
  } : base);
}

/** All fields of a platform (general + all access methods, without duplicates) */
export function platformFields(kind: PlatformKind): PlatformField[] {
  const d = PLATFORM_SETTINGS[kind], seen = new Set<string>();
  return [...d.fields, ...d.auth.flatMap(a => a.fields)].filter(f => (seen.has(f.key) ? false : (seen.add(f.key), true)));
}
export const secretKeys = (kind: PlatformKind) => platformFields(kind).filter(f => f.secret).map(f => f.key);
export const plainKeys = (kind: PlatformKind) => platformFields(kind).filter(f => !f.secret).map(f => f.key);

const filled = (v: unknown) => typeof v === 'string' ? v.trim() !== '' : v === true;
/** Configured: all required fields filled and at least one access method complete. values: plain text, or true/value for secrets. */
export function platformConfigured(kind: PlatformKind, values: Record<string, string | boolean | undefined>): boolean {
  const d = PLATFORM_SETTINGS[kind];
  return d.fields.every(f => f.optional || filled(values[f.key])) && d.auth.some(m => m.fields.every(f => f.optional || filled(values[f.key])));
}
/** Active access method: the first fully filled one, else the first with any value, else the first. */
export function activeAuthMode(kind: PlatformKind, values: Record<string, string | boolean | undefined>): string {
  const modes = PLATFORM_SETTINGS[kind].auth;
  return (modes.find(m => m.fields.every(f => f.optional || filled(values[f.key])))
    ?? modes.find(m => m.fields.some(f => filled(values[f.key])))
    ?? modes[0]).key;
}

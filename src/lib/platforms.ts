// Shop-Plattformen (Shopware 6, Shopify, Magento 2, OpenMage): Kennung, Name und Zugangsfelder für die Einstellungen.
// Reine Daten + Hilfsfunktionen, gemeinsam für Server (settings.ts, platform/*) und Oberfläche (SettingsView).
// Die Adapter selbst liegen unter src/server/platform/<kind>/ (siehe docs/platform.md).
// Texte (Feldnamen, Hinweise) stehen je Sprache in i18n/messages/lib.ts (direkt importiert: proxy.ts lädt diese Datei auch).
import { DEFAULT_LOCALE, type Locale } from './i18n/locales';
import { de as deLib, en as enLib } from './i18n/messages/lib';

const LIB: Record<Locale, typeof deLib> = { de: deLib, en: enLib };

export type PlatformKind = 'shopware' | 'shopify' | 'magento' | 'openmage';
export const PLATFORM_KINDS: readonly PlatformKind[] = ['shopware', 'shopify', 'magento', 'openmage'];
export const DEFAULT_PLATFORM: PlatformKind = 'shopware';
export const isPlatformKind = (v: unknown): v is PlatformKind => typeof v === 'string' && (PLATFORM_KINDS as readonly string[]).includes(v);

/** Ein Eingabefeld der Shop-Verbindung. secret = wird verschlüsselt gespeichert, nie angezeigt und nie an die KI gegeben. */
export interface PlatformField {
  key: string;
  label: string;
  secret?: boolean;
  /** url = Adresse (type="url"), text = sonstiger Klartext */
  type?: 'url' | 'text';
  placeholder?: string;
  /** Hilfetext unter dem Feld; **fett** wird hervorgehoben */
  hint?: string;
  /** Umgebungsvariable als Rückfall, wenn nichts gespeichert ist (z. B. SHOPWARE_URL) */
  env?: string;
  /** optional = für „eingerichtet“ nicht nötig */
  optional?: boolean;
  autoComplete?: string;
  /** Auswahlliste statt Freitext (value '' = nicht festgelegt) */
  options?: { value: string; label: string }[];
}
/** Alternative Zugangsarten (z. B. Integration oder Admin-Benutzer). Eingerichtet, sobald EINE Art vollständig ist. */
export interface PlatformAuthMode { key: string; label: string; hint?: string; fields: PlatformField[] }
export interface PlatformSettingsDescriptor {
  kind: PlatformKind;
  /** Anzeigename, z. B. „Shopware“ */
  label: string;
  /** Langform für Texte, z. B. „Shopware 6“ */
  product: string;
  /** allgemeine Felder (URL …) */
  fields: PlatformField[];
  /** Zugangsarten; die erste ist der Standard */
  auth: PlatformAuthMode[];
  /** Bezeichnung der Zugangsart-Auswahl, falls es mehrere gibt */
  authLabel?: string;
  /**
   * Pfad-Präfixe, die die Storefront ohne /shop-Präfix aufruft (Assets, Widgets, Links). proxy.ts leitet sie an den
   * Vorschau-Proxy /shop weiter, sonst bricht die Live-Vorschau. Nur erstes Segment oder feste Segmentfolge, ohne Schrägstriche außen.
   */
  storefrontPaths: readonly string[];
  /** Name der Kategorien in der Oberfläche (Shopify: Kollektion), Standard Kategorie */
  categoryNoun?: { one: string; many: string };
  /** Adapter fertig angebunden. false = Vorschau: Zugang speicherbar, Werkzeuge melden „noch nicht verfügbar“. */
  available: boolean;
  /** Alpha: angebunden, aber noch nicht im Alltag mit echten Shops erprobt (anders als Shopware). Die Oberfläche kennzeichnet das. */
  alpha?: boolean;
}

type PlatformTexts = typeof deLib.platforms;

/** Beschreibung einer Plattform mit den Texten einer Sprache (Struktur, Umgebungsvariablen und Pfade sind sprachunabhängig). */
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
/** Plattformen mit deutschen Texten (Server, Adapter); für die Oberfläche je Sprache: platformSettings(kind, locale). */
export const PLATFORM_SETTINGS: Record<PlatformKind, PlatformSettingsDescriptor> = describeAll(deLib.platforms);
const BY_LOCALE: Partial<Record<Locale, Record<PlatformKind, PlatformSettingsDescriptor>>> = { [DEFAULT_LOCALE]: PLATFORM_SETTINGS };
/** Beschreibung einer Plattform mit Feldnamen, Hinweisen und Platzhaltern in der gewünschten Sprache. */
export function platformSettings(kind: PlatformKind, locale: Locale = DEFAULT_LOCALE): PlatformSettingsDescriptor {
  const all = BY_LOCALE[locale] ??= describeAll(LIB[locale]?.platforms ?? deLib.platforms);
  return all[kind];
}
/** Name der Kategorien in der Oberfläche (Shopify: Kollektion), sonst Kategorie */
export const categoryNoun = (kind: PlatformKind | null | undefined, locale: Locale = DEFAULT_LOCALE): { one: string; many: string } =>
  (kind && platformSettings(kind, locale).categoryNoun) || (LIB[locale] ?? deLib).platforms.category;

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const ALL_STOREFRONT_PATHS = [...new Set(PLATFORM_KINDS.flatMap(k => PLATFORM_SETTINGS[k].storefrontPaths))].sort((a, b) => b.length - a.length);
const STOREFRONT_RE = new RegExp(`^/(${ALL_STOREFRONT_PATHS.map(escRe).join('|')})(/|$)`);
/**
 * Storefront-Präfix eines Pfads ohne /shop (Vereinigung aller Plattformen, proxy.ts kennt die aktive Plattform nicht),
 * z. B. '/cdn/shop/x.css' → 'cdn'. null = kein Storefront-Pfad. Ob der Präfix zur aktiven Plattform gehört, prüft die /shop-Route.
 */
export const storefrontPrefix = (pathname: string): string | null => STOREFRONT_RE.exec(pathname)?.[1] ?? null;
/** Kopfzeile, mit der proxy.ts der /shop-Route den umgeleiteten Präfix mitgibt */
export const STOREFRONT_PREFIX_HEADER = 'x-lotse-storefront-prefix';
export const isStorefrontPathOf = (kind: PlatformKind, prefix: string) => PLATFORM_SETTINGS[kind].storefrontPaths.includes(prefix);

/** Sichtbarer Bereichsname. Shopware behält Einkaufswelten; die anderen Plattformen nicht. Deutsch: info vom Server bleibt die Grundlage. */
export function scopeDisplay(kind: PlatformKind, key: string, info: { label: string; hint: string }, locale: Locale = DEFAULT_LOCALE): { label: string; hint: string } {
  const t = (LIB[locale] ?? deLib).scopes, base = locale === DEFAULT_LOCALE ? info : (t.base as Record<string, { label: string; hint: string }>)[key] ?? info;
  if (kind === 'shopware') return base;
  return (t[kind] as Record<string, { label: string; hint: string } | undefined>)[key] ?? (locale === DEFAULT_LOCALE ? {
    label: info.label.replace(/Einkaufswelten-Layouts/g, 'Seiten'),
    hint: info.hint.replace(/Produktstreams/g, 'Gruppen').replace(/Verkaufskanäle(?: & Domains)?/g, 'Vertrieb'),
  } : base);
}

export const platformLabel = (kind: PlatformKind) => PLATFORM_SETTINGS[kind].label;
/** Alle Felder einer Plattform (allgemein + alle Zugangsarten, ohne Doppelte) */
export function platformFields(kind: PlatformKind): PlatformField[] {
  const d = PLATFORM_SETTINGS[kind], seen = new Set<string>();
  return [...d.fields, ...d.auth.flatMap(a => a.fields)].filter(f => (seen.has(f.key) ? false : (seen.add(f.key), true)));
}
export const secretKeys = (kind: PlatformKind) => platformFields(kind).filter(f => f.secret).map(f => f.key);
export const plainKeys = (kind: PlatformKind) => platformFields(kind).filter(f => !f.secret).map(f => f.key);

const filled = (v: unknown) => typeof v === 'string' ? v.trim() !== '' : v === true;
/** Eingerichtet: alle Pflichtfelder gefüllt und mindestens eine Zugangsart vollständig. values: Klartext bzw. bei Geheimnissen true/Wert. */
export function platformConfigured(kind: PlatformKind, values: Record<string, string | boolean | undefined>): boolean {
  const d = PLATFORM_SETTINGS[kind];
  return d.fields.every(f => f.optional || filled(values[f.key])) && d.auth.some(m => m.fields.every(f => f.optional || filled(values[f.key])));
}
/** Aktive Zugangsart: die erste vollständig ausgefüllte, sonst die erste mit irgendeinem Wert, sonst die erste. */
export function activeAuthMode(kind: PlatformKind, values: Record<string, string | boolean | undefined>): string {
  const modes = PLATFORM_SETTINGS[kind].auth;
  return (modes.find(m => m.fields.every(f => f.optional || filled(values[f.key])))
    ?? modes.find(m => m.fields.some(f => filled(values[f.key])))
    ?? modes[0]).key;
}

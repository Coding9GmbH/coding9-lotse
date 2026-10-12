// Shop-Plattformen (Shopware 6, Shopify, Magento 2, OpenMage): Kennung, Name und Zugangsfelder für die Einstellungen.
// Reine Daten + Hilfsfunktionen, gemeinsam für Server (settings.ts, platform/*) und Oberfläche (SettingsView).
// Die Adapter selbst liegen unter src/server/platform/<kind>/ (siehe docs/platform.md).

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
}

const B = '**';
const SHOPIFY_SCOPES_HINT = `für Produkte, Dateien, Inhalte (Seiten), Übersetzungen und Sprachen, Rabatte, Veröffentlichungen, Weiterleitungen (Navigation) und Themes (für Kollektions- und Produktvorlagen), jeweils lesen und schreiben (aber ${B}keine${B} Kunden- oder Bestellrechte)`;
export const PLATFORM_SETTINGS: Record<PlatformKind, PlatformSettingsDescriptor> = {
  shopware: {
    kind: 'shopware', label: 'Shopware', product: 'Shopware 6', available: true,
    storefrontPaths: ['widgets', 'checkout', 'account', 'navigation', 'detail', 'search', 'bundles', 'theme', 'media', 'thumbnail', 'store-api'],
    fields: [
      { key: 'url', label: 'Shop-URL', type: 'url', placeholder: 'https://mein-shop.de', hint: 'Adresse deines Shopware-6-Shops, z. B. https://mein-shop.de', env: 'SHOPWARE_URL', autoComplete: 'url' },
      { key: 'publicUrl', label: 'Öffentliche URL (optional)', type: 'url', placeholder: 'https://mein-shop.de', hint: 'Nur nötig, wenn Lotse den Shop intern unter einer anderen Adresse erreicht (z. B. in Docker).', env: 'SHOPWARE_PUBLIC_URL', optional: true },
    ],
    authLabel: 'Art des Zugangs',
    auth: [
      { key: 'integration', label: 'Integration (empfohlen)',
        hint: `Lege im Shopware-Admin unter ${B}Einstellungen → System → Integrationen${B} eine neue Integration an (mit Administrator-Rechten) und kopiere Zugangs-ID und Sicherheitsschlüssel hierher.`,
        fields: [
          { key: 'clientId', label: 'Zugangs-ID', placeholder: 'SWIA…', env: 'SHOPWARE_CLIENT_ID', autoComplete: 'off' },
          { key: 'clientSecret', label: 'Sicherheitsschlüssel', secret: true, env: 'SHOPWARE_CLIENT_SECRET' },
        ] },
      { key: 'user', label: 'Admin-Benutzer',
        hint: 'Alternative zur Integration: ein Admin-Benutzer mit Schreibrechten. Ist zusätzlich eine Integration hinterlegt, wird die Integration verwendet.',
        fields: [
          { key: 'user', label: 'Admin-Benutzer', env: 'SHOPWARE_USER', autoComplete: 'username' },
          { key: 'password', label: 'Passwort', secret: true, env: 'SHOPWARE_PASSWORD', autoComplete: 'current-password' },
        ] },
    ],
  },
  shopify: {
    kind: 'shopify', label: 'Shopify', product: 'Shopify', available: true, categoryNoun: { one: 'Kollektion', many: 'Kollektionen' },
    storefrontPaths: ['cdn', 'products', 'collections', 'pages', 'cart', 'search'],
    fields: [
      { key: 'storeDomain', label: 'Shop-Domain', placeholder: 'mein-shop.myshopify.com', hint: 'Die myshopify.com-Adresse deines Shops (nicht die eigene Domain).', env: 'SHOPIFY_STORE_DOMAIN', autoComplete: 'off' },
      { key: 'publicUrl', label: 'Öffentliche URL (optional)', type: 'url', placeholder: 'https://mein-shop.de', hint: 'Eigene Domain des Shops für Links und Vorschau. Leer = Hauptdomain aus Shopify.', env: 'SHOPIFY_PUBLIC_URL', optional: true },
      { key: 'apiVersion', label: 'API-Version (optional)', placeholder: '2026-10', hint: 'Leer = von Lotse getestete Version (2026-10).', env: 'SHOPIFY_API_VERSION', optional: true },
    ],
    authLabel: 'Art des Zugangs',
    auth: [
      { key: 'app', label: 'App aus dem Dev Dashboard (für neue Apps)',
        hint: `Lege im ${B}Shopify Dev Dashboard${B} (dev.shopify.com) eine App an. Wähle in der App-Version die Admin-API-Berechtigungen ${SHOPIFY_SCOPES_HINT}, gib die Version frei und installiere die App in deinem Shop. Kopiere dann Client-ID und Client-Secret aus den Einstellungen der App hierher. Wichtig: App und Shop müssen zur ${B}selben Shopify-Organisation${B} gehören. Lotse holt damit selbst ein Zugriffstoken (gilt 24 Stunden) und erneuert es automatisch.`,
        fields: [
          { key: 'clientId', label: 'Client-ID', env: 'SHOPIFY_CLIENT_ID', autoComplete: 'off' },
          { key: 'clientSecret', label: 'Client-Secret', secret: true, env: 'SHOPIFY_CLIENT_SECRET' },
        ] },
      { key: 'token', label: 'Admin-API-Token (bestehende eigene App)',
        hint: `Für eigene Apps, die schon unter ${B}Einstellungen → Apps und Vertriebskanäle → Apps entwickeln${B} angelegt sind: Sie funktionieren weiter, neue lassen sich dort seit 1. Januar 2026 aber nicht mehr anlegen (dann die App aus dem Dev Dashboard nutzen). Die App braucht die Admin-API-Berechtigungen ${SHOPIFY_SCOPES_HINT}. Kopiere das Admin-API-Zugriffstoken hierher.`,
        fields: [{ key: 'accessToken', label: 'Admin-API-Zugriffstoken', secret: true, placeholder: 'shpat_…', env: 'SHOPIFY_ACCESS_TOKEN' }] },
    ],
  },
  magento: {
    kind: 'magento', label: 'Magento', product: 'Magento 2 (Adobe Commerce)', available: true,
    storefrontPaths: ['static', 'media', 'pub', 'catalog', 'checkout', 'customer/section'],
    fields: [
      { key: 'url', label: 'Shop-URL', type: 'url', placeholder: 'https://mein-shop.de', hint: 'Basis-Adresse deines Magento-2-Shops (REST-API unter /rest/…).', env: 'MAGENTO_URL', autoComplete: 'url' },
      { key: 'publicUrl', label: 'Öffentliche URL (optional)', type: 'url', placeholder: 'https://mein-shop.de', hint: 'Nur nötig, wenn Lotse den Shop intern unter einer anderen Adresse erreicht (z. B. in Docker).', env: 'MAGENTO_PUBLIC_URL', optional: true },
      { key: 'storeCode', label: 'Store-View (optional)', placeholder: 'default', hint: 'Code der Store-View, deren Texte Lotse liest und schreibt. Leer = default.', env: 'MAGENTO_STORE_CODE', optional: true },
      { key: 'priceBasis', label: 'Preise im Magento-Admin', env: 'MAGENTO_PRICE_BASIS', optional: true,
        options: [{ value: '', label: 'Bitte wählen' }, { value: 'gross', label: 'inkl. MwSt. (brutto)' }, { value: 'net', label: 'exkl. MwSt. (netto, Magento-Standard)' }],
        hint: `Wie im Magento-Admin unter ${B}Stores → Konfiguration → Verkäufe → Steuer → Berechnungseinstellungen → Katalogpreise${B} eingestellt. Ohne Angabe ändert Lotse keine Preise.` },
    ],
    authLabel: 'Art des Zugangs',
    auth: [
      { key: 'integration', label: 'Integration (empfohlen)',
        hint: `Lege im Magento-Admin unter ${B}System → Erweiterungen → Integrationen${B} eine Integration mit Zugriff auf Katalog, Inhalte und Marketing an, aktiviere sie und kopiere das Zugriffstoken hierher.`,
        fields: [{ key: 'accessToken', label: 'Zugriffstoken', secret: true, env: 'MAGENTO_ACCESS_TOKEN' }] },
      { key: 'user', label: 'Admin-Benutzer',
        hint: 'Alternative zur Integration: ein Admin-Benutzer mit den nötigen Rechten (ohne Zwei-Faktor-Anmeldung für die API). Ist zusätzlich ein Zugriffstoken hinterlegt, wird das Token verwendet.',
        fields: [
          { key: 'user', label: 'Admin-Benutzer', env: 'MAGENTO_USER', autoComplete: 'username' },
          { key: 'password', label: 'Passwort', secret: true, env: 'MAGENTO_PASSWORD', autoComplete: 'current-password' },
        ] },
    ],
  },
  openmage: {
    kind: 'openmage', label: 'OpenMage', product: 'OpenMage (Magento 1)', available: true,
    storefrontPaths: ['skin', 'js', 'media', 'catalog', 'catalogsearch', 'checkout', 'cms', 'index.php'],
    fields: [
      { key: 'url', label: 'Shop-URL', type: 'url', placeholder: 'https://mein-shop.de', hint: `Basis-Adresse deines OpenMage-Shops (Magento 1). Im Shop muss das Lotse-Modul ${B}Lotse_Connector${B} installiert und aktiv sein (Ordner integrations/openmage, JSON-API unter /lotse-api/v1).`, env: 'OPENMAGE_URL', autoComplete: 'url' },
      { key: 'publicUrl', label: 'Öffentliche URL (optional)', type: 'url', placeholder: 'https://mein-shop.de', hint: 'Nur nötig, wenn Lotse den Shop intern unter einer anderen Adresse erreicht (z. B. in Docker).', env: 'OPENMAGE_PUBLIC_URL', optional: true },
      { key: 'storeCode', label: 'Store-View (optional)', placeholder: 'default', hint: 'Code der Store-View, deren Texte Lotse liest und schreibt. Leer = Standard-Store-View des Shops.', env: 'OPENMAGE_STORE_CODE', optional: true },
    ],
    auth: [
      { key: 'token', label: 'API-Token',
        hint: `Im OpenMage-Admin unter ${B}System → Konfiguration → Lotse → API${B} die Schnittstelle aktivieren und mit „Token erzeugen“ einen Token anlegen (wird nur einmal angezeigt; alternativ php shell/lotse.php --generate-token). Kopiere ihn hierher. Brutto/netto liest Lotse aus der Steuerkonfiguration des Shops.`,
        fields: [{ key: 'token', label: 'API-Token', secret: true, placeholder: 'lotse_…', env: 'OPENMAGE_TOKEN' }] },
    ],
  },
};

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

// Sprachen der Oberfläche. Neue Sprache: hier eintragen, in jedem Namensraum unter messages/ ein Wörterbuch ergänzen
// (der Typ Messages erzwingt alle Schlüssel) und in LOCALE_NAMES benennen.

export const LOCALES = ['de', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'de';

/** Cookie mit der gewählten Sprache; ohne Cookie entscheidet Accept-Language. */
export const LOCALE_COOKIE = 'lotse_lang';

/** Name jeder Sprache in ihrer eigenen Sprache (für den Umschalter). */
export const LOCALE_NAMES: Record<Locale, string> = { de: 'Deutsch', en: 'English' };

/** BCP-47-Tag für Intl (Datum, Zahlen). */
export const INTL_LOCALE: Record<Locale, string> = { de: 'de-DE', en: 'en-US' };

export const isLocale = (v: unknown): v is Locale => typeof v === 'string' && (LOCALES as readonly string[]).includes(v);

/** Accept-Language auswerten (Gewichte beachten, nur die Grundsprache zählt). */
export function fromAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const ranked = header.split(',')
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map(p => p.trim()).find(p => p.startsWith('q='));
      return { lang: tag.trim().toLowerCase().split('-')[0], q: q ? Number(q.slice(2)) || 0 : 1, i };
    })
    .filter(x => x.lang && x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  return ranked.map(x => x.lang).find(isLocale) ?? null;
}

/** Sprache einer Anfrage: Cookie vor Accept-Language vor Standard. */
export function resolveLocale(cookie: string | null | undefined, acceptLanguage?: string | null): Locale {
  if (isLocale(cookie)) return cookie;
  return fromAcceptLanguage(acceptLanguage) ?? DEFAULT_LOCALE;
}

/** Wert des Sprach-Cookies aus einem Cookie-Header (für Route-Handler ohne next/headers). */
export function localeFromCookieHeader(header: string | null | undefined): Locale | null {
  const m = (header ?? '').match(new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]+)`));
  return m && isLocale(m[1]) ? m[1] : null;
}

/** Sprache eines Requests (Route-Handler): Cookie, sonst Accept-Language, sonst Standard. */
export const requestLocale = (req: Request): Locale =>
  resolveLocale(localeFromCookieHeader(req.headers.get('cookie')), req.headers.get('accept-language'));

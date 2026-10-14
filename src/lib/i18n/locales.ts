// UI languages. New language: add it here, add a dictionary in every namespace under messages/
// (the Messages type enforces all keys) and name it in LOCALE_NAMES.

export const LOCALES = ['de', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'de';

/** Cookie with the selected language; without a cookie, Accept-Language decides. */
export const LOCALE_COOKIE = 'lotse_lang';

/** Name of each language in its own language (for the switcher). */
export const LOCALE_NAMES: Record<Locale, string> = { de: 'Deutsch', en: 'English' };

/** BCP 47 tag for Intl (dates, numbers). */
export const INTL_LOCALE: Record<Locale, string> = { de: 'de-DE', en: 'en-US' };

export const isLocale = (v: unknown): v is Locale => typeof v === 'string' && (LOCALES as readonly string[]).includes(v);

/** Parse Accept-Language (respect weights, only the base language counts). */
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

/** Language of a request: cookie before Accept-Language before default. */
export function resolveLocale(cookie: string | null | undefined, acceptLanguage?: string | null): Locale {
  if (isLocale(cookie)) return cookie;
  return fromAcceptLanguage(acceptLanguage) ?? DEFAULT_LOCALE;
}

/** Value of the language cookie from a Cookie header (for route handlers without next/headers). */
export function localeFromCookieHeader(header: string | null | undefined): Locale | null {
  const m = (header ?? '').match(new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]+)`));
  return m && isLocale(m[1]) ? m[1] : null;
}

/** Language of a request (route handler): cookie, else Accept-Language, else default. */
export const requestLocale = (req: Request): Locale =>
  resolveLocale(localeFromCookieHeader(req.headers.get('cookie')), req.headers.get('accept-language'));

// Internationalization (DE/EN): typed dictionaries instead of key strings.
// Components: `const t = useT(); t.common.save`; server/helper functions: `messages(locale)`.
// Texts with placeholders or plurals are functions: `t.common.minutesAgo(5)`.
import { DEFAULT_LOCALE, INTL_LOCALE, type Locale } from './locales';
import { MESSAGES, type Messages } from './messages';

export * from './locales';
export type { Messages };

export const messages = (locale: Locale = DEFAULT_LOCALE): Messages => MESSAGES[locale] ?? MESSAGES[DEFAULT_LOCALE];

/** Number in the locale's format (1.234 / 1,234). */
export const formatNumber = (n: number, locale: Locale = DEFAULT_LOCALE, opts?: Intl.NumberFormatOptions): string =>
  n.toLocaleString(INTL_LOCALE[locale], opts);

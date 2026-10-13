// Mehrsprachigkeit (DE/EN): typisierte Wörterbücher statt Schlüssel-Strings.
// Komponenten: `const t = useT(); t.common.save`; Server/Hilfsfunktionen: `messages(locale)`.
// Texte mit Platzhaltern oder Plural sind Funktionen: `t.common.minutesAgo(5)`.
import { DEFAULT_LOCALE, INTL_LOCALE, type Locale } from './locales';
import { MESSAGES, type Messages } from './messages';

export * from './locales';
export type { Messages };

export const messages = (locale: Locale = DEFAULT_LOCALE): Messages => MESSAGES[locale] ?? MESSAGES[DEFAULT_LOCALE];

/** Zahl im Format der Sprache (1.234 / 1,234). */
export const formatNumber = (n: number, locale: Locale = DEFAULT_LOCALE, opts?: Intl.NumberFormatOptions): string =>
  n.toLocaleString(INTL_LOCALE[locale], opts);

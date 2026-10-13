import { DEFAULT_LOCALE, messages, type Locale } from './i18n';

// Texte je Sprache unter messages(locale).lib.privacy; die Konstanten sind die deutsche Fassung.

/** Was den Rechner Richtung Anthropic oder OpenAI verlässt. Steht neben dem Satz zu den Zugangsdaten. */
export const EGRESS_NOTICE = messages(DEFAULT_LOCALE).lib.privacy.egress;
export const egressNotice = (locale: Locale = DEFAULT_LOCALE): string => messages(locale).lib.privacy.egress;

/** Suchbegriffe aus der Search Console gehen mit an die KI. Kein Zugangsdatum. */
export const GSC_QUERY_NOTICE = messages(DEFAULT_LOCALE).lib.privacy.gscQuery;
export const gscQueryNotice = (locale: Locale = DEFAULT_LOCALE): string => messages(locale).lib.privacy.gscQuery;

/** Kurzfrage vor dem Entfernen eines Chats. Audit, Dateien und die Anbieter-Kopie bleiben. */
export function chatDeleteQuestion(title: string, locale: Locale = DEFAULT_LOCALE): string {
  return messages(locale).lib.privacy.chatDelete(title);
}

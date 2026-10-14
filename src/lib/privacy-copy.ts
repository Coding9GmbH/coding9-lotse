import { DEFAULT_LOCALE, messages, type Locale } from './i18n';

// Texts per language under messages(locale).lib.privacy; the constants are the German version.

/** What leaves the machine towards Anthropic or OpenAI. Shown next to the sentence about credentials. */
export const EGRESS_NOTICE = messages(DEFAULT_LOCALE).lib.privacy.egress;
export const egressNotice = (locale: Locale = DEFAULT_LOCALE): string => messages(locale).lib.privacy.egress;

/** Search terms from Search Console are sent to the AI too. Not a credential. */
export const GSC_QUERY_NOTICE = messages(DEFAULT_LOCALE).lib.privacy.gscQuery;
export const gscQueryNotice = (locale: Locale = DEFAULT_LOCALE): string => messages(locale).lib.privacy.gscQuery;
export const sistrixDataNotice = (locale: Locale = DEFAULT_LOCALE): string => messages(locale).lib.privacy.sistrixData;

/** Short prompt before removing a chat. Audit, files and the provider's copy remain. */
export function chatDeleteQuestion(title: string, locale: Locale = DEFAULT_LOCALE): string {
  return messages(locale).lib.privacy.chatDelete(title);
}

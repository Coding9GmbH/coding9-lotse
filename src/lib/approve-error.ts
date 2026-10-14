import { DEFAULT_LOCALE, messages, type Locale } from './i18n';

/** 404 after this approval was already accepted: no second error. Other errors remain. */
export function approveError(status: number, alreadySent: boolean, locale: Locale = DEFAULT_LOCALE): string | null {
  if (status === 404 && alreadySent) return null;
  const t = messages(locale).lib.approve;
  if (status === 404) return t.gone;
  return t.failed;
}

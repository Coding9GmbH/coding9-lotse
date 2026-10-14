import { DEFAULT_LOCALE, messages, type Locale } from './i18n';

/** Fixed sentence for a rejected shop login. The remote side's raw body never reaches the UI. */
export function shopLoginMessage(status: number, body: string, locale: Locale = DEFAULT_LOCALE): string {
  void status;
  void body;
  return messages(locale).lib.shopLoginRejected;
}

/** Shopware login appends the raw body to this message. Other errors (shop unreachable) stay. */
export function isShopLoginFailure(message: string): boolean {
  return /Login fehlgeschlagen/i.test(message);
}

import { DEFAULT_LOCALE, messages, type Locale } from './i18n';

/** Fester Satz für eine abgelehnte Shop-Anmeldung. Der Rohbody der Gegenstelle kommt nie in die Oberfläche. */
export function shopLoginMessage(status: number, body: string, locale: Locale = DEFAULT_LOCALE): string {
  void status;
  void body;
  return messages(locale).lib.shopLoginRejected;
}

/** Shopware-Login hängt den Rohbody an diese Meldung. Andere Fehler (Shop nicht erreichbar) bleiben. */
export function isShopLoginFailure(message: string): boolean {
  return /Login fehlgeschlagen/i.test(message);
}

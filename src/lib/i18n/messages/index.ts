// Alle Namensräume zusammengeführt. Neuer Namensraum: Datei mit `de`/`en` anlegen und hier eintragen.
import type { Locale } from '../locales';
import * as common from './common';

const ns = { common } as const;

type Namespaces = typeof ns;
/** Vollständiges Wörterbuch einer Sprache; die deutsche Fassung legt die Form fest. */
export type Messages = { [K in keyof Namespaces]: Namespaces[K]['de'] };

function build(locale: Locale): Messages {
  return Object.fromEntries(Object.entries(ns).map(([k, v]) => [k, v[locale]])) as Messages;
}

export const MESSAGES: Record<Locale, Messages> = { de: build('de'), en: build('en') };

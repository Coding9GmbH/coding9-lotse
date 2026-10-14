// Alle Namensräume zusammengeführt. Neuer Namensraum: Datei mit `de`/`en` anlegen und hier eintragen.
import type { Locale } from '../locales';
import * as common from './common';
import * as nav from './nav';
import * as settings from './settings';
import * as chat from './chat';
import * as context from './context';
import * as dialogs from './dialogs';
import * as knowledge from './knowledge';
import * as preview from './preview';
import * as workspace from './workspace';
import * as lib from './lib';
import * as server from './server';

const ns = { common, nav, settings, chat, context, dialogs, knowledge, preview, workspace, lib, server } as const;

type Namespaces = typeof ns;
/** Vollständiges Wörterbuch einer Sprache; die deutsche Fassung legt die Form fest. */
export type Messages = { [K in keyof Namespaces]: Namespaces[K]['de'] };

function build(locale: Locale): Messages {
  return Object.fromEntries(Object.entries(ns).map(([k, v]) => [k, v[locale]])) as Messages;
}

export const MESSAGES: Record<Locale, Messages> = { de: build('de'), en: build('en') };

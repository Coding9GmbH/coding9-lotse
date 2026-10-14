import { CHAT_PAGE, type ChatSummary } from './protocol';

/** Cookie für den Eingeklappt-Zustand der Navigation: der Server rendert sie gleich richtig (kein Springen beim Laden). */
export const NAV_COOKIE = 'lotse_nav';
/** Cookie mit der ID des zuletzt geöffneten Chats: der Server rendert ihn direkt (statt erst Startseite, dann Chat). */
export const CHAT_COOKIE = 'lotse_chat';

/** Shop und KI eingerichtet? Unbekannter Stand (null) sperrt nichts – der Server liefert ihn praktisch immer gleich mit. */
export const setupReady = (setup: { shopware: boolean; ai: boolean } | null | undefined): boolean => !setup || (setup.shopware && setup.ai);

/** Kontexte im Verlauf, neueste zuerst; ein Filter lohnt sich erst ab zwei verschiedenen. */
export function historyContexts(chats: Pick<ChatSummary, 'target'>[], max = 6): string[] {
  const names = [...new Set(chats.flatMap(c => (c.target?.name ? [c.target.name] : [])))].slice(0, max);
  return names.length > 1 ? names : [];
}

/** Verlauf filtern: Kontext (exakt) und Suchbegriff (Titel oder Kontextname, ohne Groß-/Kleinschreibung). */
export function filterHistory<T extends Pick<ChatSummary, 'title' | 'target'>>(chats: T[], query: string, context: string | null): T[] {
  const q = query.trim().toLowerCase();
  return chats.filter(c => (!context || c.target?.name === context) && (!q || c.title.toLowerCase().includes(q) || !!c.target?.name?.toLowerCase().includes(q)));
}

// ---- Verlauf blättern: erste Seite (wird laufend aufgefrischt) + nachgeladene ältere Seiten ----
/** Zusammen anzeigen: erste Seite vorne, ältere ohne Doppelte dahinter (ein aufgefrischter Chat wandert nach vorn). */
export function mergeChatPages<T extends Pick<ChatSummary, 'id'>>(first: T[] | null, older: T[]): T[] | null {
  if (!first || !older.length) return first;
  const ids = new Set(first.map(c => c.id));
  return [...first, ...older.filter(c => !ids.has(c.id))];
}
/** Nach dem Auffrischen der ersten Seite: Chats, die aus ihr herausgerutscht sind (neue Chats davor), gehören an den Anfang der älteren –
 *  sonst fehlten sie zwischen beiden Seiten. Gelöschte (removed) nicht; ohne nachgeladene Seiten bleibt alles wie bisher. */
export function rollChatPages<T extends Pick<ChatSummary, 'id'>>(prevFirst: T[] | null, nextFirst: T[], older: T[], removed: ReadonlySet<string> = new Set()): T[] {
  if (!older.length) return older;
  const next = new Set(nextFirst.map(c => c.id)), dropped = (prevFirst ?? []).filter(c => !next.has(c.id) && !removed.has(c.id)), seen = new Set(dropped.map(c => c.id));
  return [...dropped, ...older.filter(c => !seen.has(c.id) && !removed.has(c.id))];
}
/** Volle Seite = vielleicht gibt es mehr (die letzte geladene Seite entscheidet). */
export const pageFull = (n: number) => n >= CHAT_PAGE;

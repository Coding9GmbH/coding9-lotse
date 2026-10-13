import type { ChatSummary } from './protocol';

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

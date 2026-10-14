import { CHAT_PAGE, type ChatSummary } from './protocol';

/** Cookie for the navigation's collapsed state: the server renders it correctly right away (no jump on load). */
export const NAV_COOKIE = 'lotse_nav';
/** Cookie with the ID of the last opened chat: the server renders it directly (instead of home page first, then chat). */
export const CHAT_COOKIE = 'lotse_chat';

/** Shop and AI set up? Unknown state (null) blocks nothing; the server practically always sends it along. */
export const setupReady = (setup: { shopware: boolean; ai: boolean } | null | undefined): boolean => !setup || (setup.shopware && setup.ai);

/** Contexts in the history, newest first; a filter is only worthwhile from two distinct ones. */
export function historyContexts(chats: Pick<ChatSummary, 'target'>[], max = 6): string[] {
  const names = [...new Set(chats.flatMap(c => (c.target?.name ? [c.target.name] : [])))].slice(0, max);
  return names.length > 1 ? names : [];
}

/** Filter the history: context (exact) and search term (title or context name, case-insensitive). */
export function filterHistory<T extends Pick<ChatSummary, 'title' | 'target'>>(chats: T[], query: string, context: string | null): T[] {
  const q = query.trim().toLowerCase();
  return chats.filter(c => (!context || c.target?.name === context) && (!q || c.title.toLowerCase().includes(q) || !!c.target?.name?.toLowerCase().includes(q)));
}

// ---- History paging: first page (refreshed continuously) + older pages loaded later ----
/** Show together: first page in front, older ones without duplicates after it (a refreshed chat moves to the front). */
export function mergeChatPages<T extends Pick<ChatSummary, 'id'>>(first: T[] | null, older: T[]): T[] | null {
  if (!first || !older.length) return first;
  const ids = new Set(first.map(c => c.id));
  return [...first, ...older.filter(c => !ids.has(c.id))];
}
/** After refreshing the first page: chats that slipped out of it (new chats before them) go to the start of the older ones,
 *  otherwise they'd be missing between both pages. Not deleted ones (removed); without loaded pages everything stays as before. */
export function rollChatPages<T extends Pick<ChatSummary, 'id'>>(prevFirst: T[] | null, nextFirst: T[], older: T[], removed: ReadonlySet<string> = new Set()): T[] {
  if (!older.length) return older;
  const next = new Set(nextFirst.map(c => c.id)), dropped = (prevFirst ?? []).filter(c => !next.has(c.id) && !removed.has(c.id)), seen = new Set(dropped.map(c => c.id));
  return [...dropped, ...older.filter(c => !seen.has(c.id) && !removed.has(c.id))];
}
/** Full page = there may be more (the last loaded page decides). */
export const pageFull = (n: number) => n >= CHAT_PAGE;

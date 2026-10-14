// Shop check findings being worked on in a chat via "Als Auftrag ins Feld" (per browser, convenience only).
// Finding IDs are stable (e.g. 'seo.meta-description-missing'); if the finding disappears, the entry doesn't matter.

export interface FixLink { chatId: string; title: string; at: string }
export type FixMap = Record<string, FixLink>;

const KEY = 'lotse_fixes';
const MAX = 50;

export function loadFixes(): FixMap {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as FixMap : {};
  } catch { return {}; }
}

/** Remember finding ↔ chat (newest first, at most MAX entries). */
export function rememberFix(map: FixMap, findingId: string, link: FixLink): FixMap {
  const next = Object.fromEntries([[findingId, link] as const, ...Object.entries(map).filter(([id]) => id !== findingId)].slice(0, MAX));
  try { window.localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private window: only for this session */ }
  return next;
}

/** Which finding does this chat belong to? */
export const fixForChat = (map: FixMap, chatId: string | null): FixLink | null =>
  (chatId && Object.values(map).find(l => l.chatId === chatId)) || null;

/** Does the sent message stem from the shop check's task? (It may be extended or shortened, the beginning stays.) */
export const sentFix = (prompt: string, message: string): boolean => {
  const head = prompt.trim().slice(0, 40);
  return !!head && message.includes(head);
};

// Shop-Check-Befunde, die über „Als Auftrag ins Feld“ in einem Chat bearbeitet werden (je Browser, nur Komfort).
// Befund-IDs sind stabil (z. B. 'seo.meta-description-missing'); verschwindet der Befund, ist der Eintrag egal.

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

/** Befund ↔ Chat merken (neueste zuerst, höchstens MAX Einträge). */
export function rememberFix(map: FixMap, findingId: string, link: FixLink): FixMap {
  const next = Object.fromEntries([[findingId, link] as const, ...Object.entries(map).filter(([id]) => id !== findingId)].slice(0, MAX));
  try { window.localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* privates Fenster: nur für diese Sitzung */ }
  return next;
}

/** Zu welchem Befund gehört dieser Chat? */
export const fixForChat = (map: FixMap, chatId: string | null): FixLink | null =>
  (chatId && Object.values(map).find(l => l.chatId === chatId)) || null;

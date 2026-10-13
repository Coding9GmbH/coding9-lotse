import { DEFAULT_LOCALE, messages, type Locale } from './i18n';

/** Satz unter jedem offenen Set: der Klick schreibt in den verbundenen Shop, und ob Rückgängig vorgesehen ist. */
export function applyHint({ selectable, undoPlanned }: { selectable: boolean; undoPlanned: boolean }, locale: Locale = DEFAULT_LOCALE): string {
  const t = messages(locale).lib.approve;
  return `${selectable ? t.writeRows : t.writeShop} ${undoPlanned ? t.undoYes : t.undoIf}`;
}

/** Vor dem Ergebnis bekannt: Zeilen, die keine reinen Hinweise sind, stellt Rückgängig auf die vorherigen Werte. Sonst ist Undo nicht zuverlässig bekannt. */
export function undoPlannedFor(cs: { items: { entity: string }[] }): boolean {
  return cs.items.some(i => i.entity !== 'info');
}

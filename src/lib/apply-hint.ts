const WRITE_ROWS = 'Der Klick schreibt die ausgewählten Zeilen in den verbundenen Shop.';
const WRITE_SHOP = 'Der Klick schreibt in den verbundenen Shop.';
const UNDO_YES = 'Rückgängig stellt die geschriebenen Zeilen auf die vorherigen Werte.';
const UNDO_IF = 'Rückgängig gibt es nur, wenn der Shop die vorherigen Werte zurückgibt.';

/** Satz unter jedem offenen Set: der Klick schreibt in den verbundenen Shop, und ob Rückgängig vorgesehen ist. */
export function applyHint({ selectable, undoPlanned }: { selectable: boolean; undoPlanned: boolean }): string {
  return `${selectable ? WRITE_ROWS : WRITE_SHOP} ${undoPlanned ? UNDO_YES : UNDO_IF}`;
}

/** Vor dem Ergebnis bekannt: Zeilen, die keine reinen Hinweise sind, stellt Rückgängig auf die vorherigen Werte. Sonst ist Undo nicht zuverlässig bekannt. */
export function undoPlannedFor(cs: { items: { entity: string }[] }): boolean {
  return cs.items.some(i => i.entity !== 'info');
}

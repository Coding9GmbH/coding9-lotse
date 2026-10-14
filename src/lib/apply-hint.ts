import { DEFAULT_LOCALE, messages, type Locale } from './i18n';

/** Sentence under every open set: the click writes to the connected shop, and whether undo is provided. */
export function applyHint({ selectable, undoPlanned }: { selectable: boolean; undoPlanned: boolean }, locale: Locale = DEFAULT_LOCALE): string {
  const t = messages(locale).lib.approve;
  return `${selectable ? t.writeRows : t.writeShop} ${undoPlanned ? t.undoYes : t.undoIf}`;
}

/** Known before the result: undo restores rows that are not mere notes to their previous values. Otherwise undo is not reliably known. */
export function undoPlannedFor(cs: { items: { entity: string }[] }): boolean {
  return cs.items.some(i => i.entity !== 'info');
}

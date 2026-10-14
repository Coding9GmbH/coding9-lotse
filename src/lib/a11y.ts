import { DEFAULT_LOCALE, messages, type Locale } from './i18n';

/** Announcement when a reply is finished. Stays silent while it is being written. */
export function announceAnswer(done: boolean, locale: Locale = DEFAULT_LOCALE): string | null {
  return done ? messages(locale).lib.chat.answered : null;
}

/** Enter and Space select the focused target in mark mode. */
export function markKeySelects(key: string): boolean {
  return key === 'Enter' || key === ' ';
}

/**
 * Make siblings outside `keep` inert. `keep` and its ancestors stay usable.
 * `data-dismiss` (scrim, backdrop) stays clickable. Cleanup only removes the marks it set itself.
 */
export function inertExcept(keep: HTMLElement): () => void {
  const touched: HTMLElement[] = [];
  let node: HTMLElement | null = keep;
  while (node.parentElement && node.parentElement !== document.body) {
    for (const sib of node.parentElement.children) {
      if (!(sib instanceof HTMLElement) || sib === node) continue;
      if (sib.hasAttribute('data-dismiss') || sib.hasAttribute('inert')) continue;
      sib.setAttribute('inert', '');
      touched.push(sib);
    }
    node = node.parentElement;
  }
  return () => { for (const el of touched) el.removeAttribute('inert'); };
}

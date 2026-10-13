import { DEFAULT_LOCALE, messages, type Locale } from './i18n';

/** Ansage, wenn eine Antwort fertig ist. Während des Schreibens bleibt es still. */
export function announceAnswer(done: boolean, locale: Locale = DEFAULT_LOCALE): string | null {
  return done ? messages(locale).lib.chat.answered : null;
}

/** Enter und Leertaste wählen das fokussierte Ziel im Markier-Modus. */
export function markKeySelects(key: string): boolean {
  return key === 'Enter' || key === ' ';
}

/**
 * Geschwister außerhalb von `keep` unbedienbar machen. `keep` und seine Vorfahren bleiben.
 * `data-dismiss` (Scrim, Backdrop) bleibt klickbar. Aufräumen hebt nur die selbst gesetzten Marken auf.
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

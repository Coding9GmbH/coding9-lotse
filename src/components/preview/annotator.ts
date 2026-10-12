// Markier-Modus in einer Vorschau: Element unter dem Mauszeiger umranden, Klick liefert Bezeichnung, Abschnitt, CSS-Pfad und Position.
// Zwei Wege: Shop-Seite über /shop (gleiche Herkunft, direkt im Dokument) und Entwurf im sandboxed iframe (nur postMessage,
// die Logik dort liefert lib/preview-frame.ts).
import { describeElement } from '@/lib/annotations';
import { FRAME_CSS, isFrameMessage, MEANINGFUL } from '@/lib/preview-frame';
import { isSandboxed, postToFrame } from './DraftFrame';

export interface Pick { label: string; section?: string; path: string; x: number; y: number }

const STYLE_ID = 'lotse-annotate';
const str = (v: unknown, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');

function target(el: Element | null): Element | null {
  if (!el) return null;
  return el.closest(MEANINGFUL) ?? el.closest('section,article,.cms-block,.cms-section') ?? el;
}

function cssPath(el: Element): string {
  const parts: string[] = [];
  for (let e: Element | null = el; e && e.tagName !== 'BODY' && parts.length < 4; e = e.parentElement) {
    const cls = [...e.classList].filter(c => !c.startsWith('__lotse') && !/^aicb-|^css-/.test(c)).slice(0, 2);
    parts.unshift(e.tagName.toLowerCase() + cls.map(c => `.${c}`).join(''));
    if (e.tagName === 'SECTION') break;
  }
  return parts.join(' > ');
}

function sectionTitle(el: Element): string | undefined {
  const sec = el.closest('section,.cms-section,article');
  const h = sec?.querySelector('h1,h2,h3');
  const t = h?.textContent?.replace(/\s+/g, ' ').trim();
  return t ? (t.length > 60 ? `${t.slice(0, 57)}…` : t) : undefined;
}

/** Entwurf (sandboxed): Markier-Modus im Dokument einschalten, Klicks kommen als Nachricht zurück. */
function attachByMessage(frame: HTMLIFrameElement, onPick: (p: Pick) => void): () => void {
  const onMsg = (e: MessageEvent) => {
    if (e.source !== frame.contentWindow || !isFrameMessage(e.data) || e.data.t !== 'pick') return;
    const d = e.data;
    onPick({ label: describeElement(str(d.tag, 30), { text: str(d.text), alt: str(d.alt), isButton: !!d.isButton }), section: str(d.section, 80) || undefined, path: str(d.path), x: Number(d.x) || 0, y: Number(d.y) || 0 });
  };
  const bind = () => postToFrame(frame, { t: 'mark', on: true });
  window.addEventListener('message', onMsg);
  bind();
  frame.addEventListener('load', bind); // Entwurf neu geladen → wieder einschalten
  return () => { window.removeEventListener('message', onMsg); frame.removeEventListener('load', bind); postToFrame(frame, { t: 'mark', on: false }); };
}

/** Schaltet den Markier-Modus in einem iframe ein; liefert die Abmeldefunktion. */
export function attachAnnotator(frame: HTMLIFrameElement, onPick: (p: Pick) => void): () => void {
  if (isSandboxed(frame)) return attachByMessage(frame, onPick);
  let doc: Document | null = null, hovered: Element | null = null;
  const over = (e: Event) => {
    const t = target(e.target as Element);
    if (t === hovered) return;
    hovered?.classList.remove('__lotse-hover'); hovered = t; t?.classList.add('__lotse-hover');
  };
  const leave = () => { hovered?.classList.remove('__lotse-hover'); hovered = null; };
  const click = (e: MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const t = target(e.target as Element); if (!t) return;
    const isButton = t.tagName === 'BUTTON' || t.classList.contains('btn') || /button/.test(t.className.toString());
    const text = (t as HTMLElement).innerText ?? t.textContent ?? '';
    onPick({ label: describeElement(t.tagName, { text, alt: (t as HTMLImageElement).alt, isButton }), section: sectionTitle(t), path: cssPath(t), x: e.clientX, y: e.clientY });
  };
  const block = (e: Event) => { e.preventDefault(); e.stopPropagation(); }; // keine Navigation/Formulare im Markier-Modus

  const bind = () => {
    unbind();
    try { doc = frame.contentDocument; } catch { doc = null; }
    if (!doc?.documentElement) return;
    if (!doc.getElementById(STYLE_ID)) { const st = doc.createElement('style'); st.id = STYLE_ID; st.textContent = FRAME_CSS; doc.head?.appendChild(st); }
    doc.documentElement.classList.add('__lotse-on');
    doc.addEventListener('mouseover', over, true);
    doc.addEventListener('mouseleave', leave, true);
    doc.addEventListener('click', click, true);
    doc.addEventListener('submit', block, true);
    doc.addEventListener('auxclick', block, true);
  };
  const unbind = () => {
    if (!doc) return;
    leave();
    doc.documentElement?.classList.remove('__lotse-on');
    doc.removeEventListener('mouseover', over, true);
    doc.removeEventListener('mouseleave', leave, true);
    doc.removeEventListener('click', click, true);
    doc.removeEventListener('submit', block, true);
    doc.removeEventListener('auxclick', block, true);
    doc = null;
  };
  bind();
  frame.addEventListener('load', bind); // Entwurf neu geladen → wieder anbinden
  return () => { frame.removeEventListener('load', bind); unbind(); };
}

/** Nummern an den markierten Elementen anzeigen (Best effort über den CSS-Pfad). */
export function drawPins(frame: HTMLIFrameElement, paths: string[]) {
  if (isSandboxed(frame)) { postToFrame(frame, { t: 'pins', paths }); return; }
  let doc: Document | null = null;
  try { doc = frame.contentDocument; } catch { return; }
  if (!doc?.body) return;
  doc.querySelectorAll('.__lotse-pin').forEach(p => p.remove());
  const win = doc.defaultView;
  paths.forEach((path, i) => {
    let el: Element | null = null;
    try { el = doc!.querySelector(path); } catch { /* ungültiger Pfad */ }
    if (!el || !win) return;
    const r = el.getBoundingClientRect(), pin = doc!.createElement('span');
    pin.className = '__lotse-pin'; pin.textContent = String(i + 1);
    pin.style.left = `${Math.max(4, r.left + win.scrollX - 8)}px`; pin.style.top = `${Math.max(4, r.top + win.scrollY - 10)}px`;
    doc!.body.appendChild(pin);
  });
}

'use client';

import { useEffect, useRef } from 'react';
import type { DraftView } from '@/lib/chat-state';
import { FRAME_TAG, isFrameMessage, type ToFrame } from '@/lib/preview-frame';

interface Props { draft: DraftView | null; className?: string; hidden: boolean }

/** Nachricht an das Vorschau-Dokument (opaker Origin → targetOrigin "*", das Dokument prüft event.source) */
export const postToFrame = (f: HTMLIFrameElement, m: ToFrame) => f.contentWindow?.postMessage({ lotse: FRAME_TAG, ...m }, '*');
/** iframe ohne Zugriff auf das eingebettete Dokument (sandbox ohne allow-same-origin) → nur postMessage */
export const isSandboxed = (f: HTMLIFrameElement) => f.hasAttribute('sandbox') && !f.sandbox.contains('allow-same-origin');

/** Live-Vorschau (Shop-Seite über den Proxy): gleiche Herkunft, damit der Annotator contentDocument lesen kann, Formulare erlaubt,
 *  aber keine Skripte – Shop-JS läuft nie in Lotses Herkunft. Der Entwurf nutzt stattdessen sandbox="allow-scripts" (siehe unten). */
export const PREVIEW_SANDBOX = 'allow-same-origin allow-forms';

/**
 * Entwurfs-Vorschau (srcdoc) in einem sandboxed iframe: Skripte aus custom-html-Blöcken und Shop-HTML laufen in einem
 * eigenen, opaken Origin ohne Zugriff auf die Oberfläche und die API (Freigaben bleiben beim Menschen).
 * Während des Streamens (draft_partial) wird per postMessage nur der <body> ausgetauscht, Theme-CSS und Scroll-Position bleiben.
 * Der fertige Entwurf lädt das Dokument neu (damit Skripte laufen) und stellt die zuletzt gemeldete Scroll-Position wieder her.
 */
export function DraftFrame({ draft, className, hidden }: Props) {
  const ref = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const scrollY = useRef(0);

  // Scroll-Position meldet das Dokument selbst (lesbar ist es von hier aus nicht)
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const f = ref.current;
      if (!f || e.source !== f.contentWindow || !isFrameMessage(e.data) || e.data.t !== 'scroll') return;
      scrollY.current = Math.max(0, Number(e.data.top) || 0);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  useEffect(() => {
    const f = ref.current;
    if (!f || !draft) return;
    if (draft.partial && ready.current) { postToFrame(f, { t: 'body', html: draft.html }); return; }
    const y = ready.current ? scrollY.current : 0;
    ready.current = false;
    const onLoad = () => { ready.current = true; if (y) postToFrame(f, { t: 'scroll', top: y }); };
    f.addEventListener('load', onLoad, { once: true });
    f.srcdoc = draft.html;
    return () => f.removeEventListener('load', onLoad);
  }, [draft]);

  return <iframe ref={ref} sandbox="allow-scripts" className={className} hidden={hidden} data-kind="prev" title="Entwurf mit dem Theme des Shops" />;
}

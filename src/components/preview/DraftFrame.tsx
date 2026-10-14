'use client';

import { useEffect, useRef } from 'react';
import type { DraftView } from '@/lib/chat-state';
import { FRAME_TAG, isFrameMessage, withFrameCsp, type ToFrame } from '@/lib/preview-frame';

interface Props { draft: DraftView | null; className?: string; hidden: boolean; title: string }

/** Message to the preview document (opaque origin → targetOrigin "*", the document checks event.source) */
export const postToFrame = (f: HTMLIFrameElement, m: ToFrame) => f.contentWindow?.postMessage({ lotse: FRAME_TAG, ...m }, '*');
/** iframe without access to the embedded document (sandbox without allow-same-origin) → postMessage only */
export const isSandboxed = (f: HTMLIFrameElement) => f.hasAttribute('sandbox') && !f.sandbox.contains('allow-same-origin');

/** Live preview (shop page via the proxy): scripts and forms run, but in an opaque origin (no allow-same-origin), never in
 *  Lotse's origin. The proxy additionally sets `sandbox` via CSP. Marking and scroll work via postMessage, as with the draft. */
export const PREVIEW_SANDBOX = 'allow-scripts allow-forms';

/**
 * Draft preview (srcdoc) in a sandboxed iframe: scripts from custom-html blocks and shop HTML run in their
 * own opaque origin without access to the UI and the API (approvals stay with the human).
 * While streaming (draft_partial) only the <body> is swapped via postMessage, theme CSS and scroll position stay.
 * The finished draft reloads the document (so scripts run) and restores the last reported scroll position.
 */
export function DraftFrame({ draft, className, hidden, title }: Props) {
  const ref = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const scrollY = useRef(0);

  // The document reports its scroll position itself (it is not readable from here)
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
    f.srcdoc = withFrameCsp(draft.html); // connect-src/form-action 'none': AI JS cannot send anything from the preview
    return () => f.removeEventListener('load', onLoad);
  }, [draft]);

  return <iframe ref={ref} sandbox="allow-scripts" className={className} hidden={hidden} data-kind="prev" title={title} />;
}

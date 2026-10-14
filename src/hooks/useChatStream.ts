'use client';

import { useCallback, useEffect, useRef } from 'react';
import { ApiError, errorText, listenChat, postChat } from '@/lib/api';
import { createLineSplitter } from '@/lib/ndjson';
import type { ChatEvent, ChatRequest } from '@/lib/protocol';

interface Handlers { onEvent: (ev: ChatEvent) => void; onError: (message: string, status?: number) => void }

/**
 * Reads chat events as an NDJSON stream: run() starts a new turn (POST), listen() connects to an
 * existing chat (GET: first "snapshot", then live). abort() only drops the connection; the turn keeps running on the
 * server.
 */
export function useChatStream() {
  const ctrl = useRef<AbortController | null>(null);

  const abort = useCallback(() => { ctrl.current?.abort(); ctrl.current = null; }, []);
  useEffect(() => abort, [abort]);

  const read = useCallback(async (open: (signal: AbortSignal) => Promise<Response>, { onEvent, onError }: Handlers): Promise<void> => {
    ctrl.current?.abort();
    const ac = new AbortController();
    ctrl.current = ac;
    try {
      const r = await open(ac.signal);
      if (!r.ok || !r.body) {
        const t = await r.text().catch(() => '');
        let msg = t;
        try { const j = JSON.parse(t) as { error?: string; message?: string }; msg = j.error ?? j.message ?? t; } catch { /* plain text */ }
        throw new ApiError(msg || `HTTP ${r.status}`, r.status);
      }
      const reader = r.body.getReader();
      const split = createLineSplitter(line => {
        let ev: ChatEvent;
        try { ev = JSON.parse(line) as ChatEvent; } catch { return; }
        onEvent(ev);
      });
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        split.push(value);
      }
      split.end();
    } catch (e) {
      if (!ac.signal.aborted) onError(errorText(e), e instanceof ApiError ? e.status : undefined);
    } finally {
      if (ctrl.current === ac) ctrl.current = null;
    }
  }, []);

  const run = useCallback((body: ChatRequest, h: Handlers) => read(signal => postChat(body, signal), h), [read]);
  const listen = useCallback((chatId: string, h: Handlers) => read(signal => listenChat(chatId, signal), h), [read]);

  return { run, listen, abort };
}

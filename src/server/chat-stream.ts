import 'server-only';
// NDJSON stream for a UI listening to a chat. Closes after "done"; if the client aborts,
// only the listener is removed; the AI turn keeps running.
import type { ChatEvent } from '@/lib/protocol';
import type { Session } from './sessions';

export function listenStream(s: Session, first: ChatEvent[], live: boolean): Response {
  const enc = new TextEncoder();
  let listener: ((ev: ChatEvent) => void) | null = null;
  const detach = () => { if (listener) s.listeners.delete(listener); listener = null; };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const close = () => { if (closed) return; closed = true; detach(); try { controller.close(); } catch { /* already closed */ } };
      const send = (ev: ChatEvent) => {
        if (closed) return;
        try { controller.enqueue(enc.encode(JSON.stringify(ev) + '\n')); } catch { close(); return; }
        if (ev.t === 'done') close();
      };
      for (const ev of first) send(ev);
      if (!live) { close(); return; }
      listener = send;
      s.listeners.add(listener);
    },
    cancel() { detach(); },
  });
  return new Response(stream, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' } });
}

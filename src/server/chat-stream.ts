import 'server-only';
// NDJSON-Strom einer Oberfläche, die einem Chat zuhört. Schließt sich nach „done“; bricht der Client ab,
// wird nur der Listener entfernt – die KI-Runde läuft weiter.
import type { ChatEvent } from '@/lib/protocol';
import type { Session } from './sessions';

export function listenStream(s: Session, first: ChatEvent[], live: boolean): Response {
  const enc = new TextEncoder();
  let listener: ((ev: ChatEvent) => void) | null = null;
  const detach = () => { if (listener) s.listeners.delete(listener); listener = null; };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const close = () => { if (closed) return; closed = true; detach(); try { controller.close(); } catch { /* schon zu */ } };
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

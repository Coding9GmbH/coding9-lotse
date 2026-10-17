import type { SandboxCheckEvent } from '@/lib/protocol';
import { checkEnvironment, sandboxForbidden } from '@/server/sandbox/env';

export const dynamic = 'force-dynamic';

/** "Umgebung prüfen": NDJSON with progress lines (image pull) and a final result. */
export function POST(req: Request) {
  const off = sandboxForbidden();
  if (off) return off;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (ev: SandboxCheckEvent) => { try { controller.enqueue(enc.encode(`${JSON.stringify(ev)}\n`)); } catch { /* client gone */ } };
      let last = 0;
      const result = await checkEnvironment((text, pct) => {
        const now = Date.now();
        if (now - last < 250 && pct !== 100) return; // pull reports many lines per second
        last = now; send({ t: 'progress', text, ...(pct !== undefined ? { pct } : {}) });
      }, req.signal);
      send(result);
      try { controller.close(); } catch { /* already closed */ }
    },
  });
  return new Response(stream, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' } });
}

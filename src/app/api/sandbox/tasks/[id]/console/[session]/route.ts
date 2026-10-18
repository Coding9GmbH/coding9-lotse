import { z } from 'zod';
import type { ConsoleEvent } from '@/lib/protocol';
import { actorFromRequest } from '@/server/actor';
import { parseJson } from '@/server/http';
import { taskRoute } from '@/server/sandbox/api';
import { attachConsole, closeConsole, consoleInput, resizeConsole } from '@/server/sandbox/console';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string; session: string }> };

/** queued for one view at most; a view that falls further behind (slow connection, a flood of output) is dropped and reconnects
 *  from its last chunk – the server keeps the end of the output, the view marks the gap */
const VIEW_QUEUE_BYTES = 1024 * 1024;

/** NDJSON: the console's output from chunk ?from= on (buffered chunks first, e.g. after a reload), live, then its end. */
export function GET(req: Request, { params }: Ctx) {
  return taskRoute(req, async () => {
    const { id, session } = await params;
    const from = Math.max(0, Math.floor(Number(new URL(req.url).searchParams.get('from') ?? 0)) || 0);
    const enc = new TextEncoder();
    let detach: (() => void) | null = null, closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const stop = () => { if (closed) return; closed = true; detach?.(); detach = null; try { controller.close(); } catch { /* closed */ } };
        const send = (ev: ConsoleEvent) => {
          if (closed) return;
          try { controller.enqueue(enc.encode(`${JSON.stringify(ev)}\n`)); } catch { stop(); return; }
          if (ev.t === 'end' || (controller.desiredSize ?? 0) <= 0) queueMicrotask(stop);
        };
        detach = attachConsole(id, session, actorFromRequest(req), from, send); // throws 404 before the stream exists
        if (closed) detach();
        req.signal.addEventListener('abort', stop, { once: true });
      },
      cancel() { closed = true; detach?.(); detach = null; },
    }, new ByteLengthQueuingStrategy({ highWaterMark: VIEW_QUEUE_BYTES }));
    return new Response(stream, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache, no-store', 'x-accel-buffering': 'no' } });
  });
}

const schema = z.union([
  z.object({ input: z.string() }).strict(),
  z.object({ resize: z.object({ cols: z.number().int(), rows: z.number().int() }).strict() }).strict(),
]);

/** Keystrokes/pasted text ({input}) or a new size ({resize}). Input is never logged or audited. */
export function POST(req: Request, { params }: Ctx) {
  return taskRoute(req, async () => {
    const body = await parseJson(req, schema);
    if (!body.ok) return body.res;
    const { id, session } = await params, actor = actorFromRequest(req);
    if ('input' in body.data) consoleInput(id, session, actor, body.data.input);
    else await resizeConsole(id, session, actor, body.data.resize);
    return new Response(null, { status: 204 });
  });
}

/** Close: ends the shell in the container (audited). */
export function DELETE(req: Request, { params }: Ctx) {
  return taskRoute(req, async () => {
    const { id, session } = await params;
    await closeConsole(id, session, actorFromRequest(req));
    return Response.json({ ok: true });
  });
}

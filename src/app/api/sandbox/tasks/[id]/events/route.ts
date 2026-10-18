import type { TaskEvent } from '@/lib/protocol';
import { taskRoute } from '@/server/sandbox/api';
import { touchTask } from '@/server/sandbox/jobs';
import { listen, mustTask, publicTask, takeHeldChat } from '@/server/sandbox/tasks';

export const dynamic = 'force-dynamic';

/** NDJSON: the task as snapshot (plus chat events held for the first view, tasks.ts emitChatToViews), then live (task on every transition, log lines). An open view counts as activity (no idle pause). */
export function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return taskRoute(req, async () => {
    const t = mustTask((await params).id);
    touchTask(t.id);
    const enc = new TextEncoder();
    let stop: (() => void) | null = null;
    const end = () => { if (!stop) return; stop(); stop = null; touchTask(t.id); };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (ev: TaskEvent) => {
          try { controller.enqueue(enc.encode(`${JSON.stringify(ev)}\n`)); } catch { end(); return; }
          if (ev.t === 'deleted') { end(); try { controller.close(); } catch { /* closed */ } }
        };
        send({ t: 'task', task: publicTask(t) });
        stop = listen(t.id, send);
        for (const event of takeHeldChat(t.id)) send({ t: 'chat', event }); // e.g. which sandboxes its start paused
        req.signal.addEventListener('abort', end, { once: true });
      },
      cancel() { end(); },
    });
    return new Response(stream, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' } });
  });
}

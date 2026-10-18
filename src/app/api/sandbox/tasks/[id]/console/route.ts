import { z } from 'zod';
import { actorFromRequest } from '@/server/actor';
import { parseJson } from '@/server/http';
import { taskRoute } from '@/server/sandbox/api';
import { listConsoles, openConsole } from '@/server/sandbox/console';
import { mustTask } from '@/server/sandbox/tasks';
import { CONSOLE_MAX } from '@/lib/protocol';

export const dynamic = 'force-dynamic';

const schema = z.object({ cols: z.number().int(), rows: z.number().int() }).strict();

/** The user's open consoles of this task (a reloaded view attaches to them again). Never offered to the AI. */
export function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return taskRoute(req, async () => {
    const t = mustTask((await params).id);
    return Response.json({ sessions: listConsoles(t.id, actorFromRequest(req)), max: CONSOLE_MAX });
  });
}

/** "Neue Konsole": wakes a paused sandbox and starts a shell in its container (audited: opened, by whom). */
export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return taskRoute(req, async () => {
    const body = await parseJson(req, schema);
    if (!body.ok) return body.res;
    const id = (await params).id;
    return Response.json({ session: await openConsole(id, actorFromRequest(req), body.data) });
  });
}

import fs from 'node:fs';
import { z } from 'zod';
import type { ContainerChanges, ContainerTakeOver } from '@/lib/protocol';
import { messages } from '@/lib/i18n';
import { requestLocale } from '@/lib/i18n/locales';
import { jsonError, parseJson } from '@/server/http';
import { taskRoute } from '@/server/sandbox/api';
import { PULL_LIMITS, containerChanges, takeOver } from '@/server/sandbox/container-pull';
import { ensureAwake, setupBusy, withTaskLock } from '@/server/sandbox/jobs';
import { mustTask, publishRunning, taskPaths, turnRunning, type CodeTask } from '@/server/sandbox/tasks';

export const dynamic = 'force-dynamic';

/** Only a set-up, unfinished sandbox with its working copy; never during a setup, a publish or (taking over) an AI turn. A paused one wakes. */
async function ready(req: Request, id: string, write: boolean): Promise<CodeTask | Response> {
  const m = messages(requestLocale(req)).server, t = mustTask(id);
  if (t.status === 'done' || !t.layout || !fs.existsSync(taskPaths(id).worktree) || !t.steps.some(s => s.key === 'clone' && s.state === 'done')) return jsonError(409, m.pullNotReady);
  if (setupBusy(id) || publishRunning(id)) return jsonError(409, m.pullBusy);
  if (write && turnRunning(id)) return jsonError(409, m.repoTurnRunning);
  await ensureAwake(id);
  return mustTask(id);
}

/** "Aus dem Container übernehmen" → compare: what differs between the task container's synced folders and the worktree (with a diff). */
export function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return taskRoute(req, async () => {
    const id = (await params).id, t = await ready(req, id, false);
    if (t instanceof Response) return t;
    return Response.json(await withTaskLock(id, () => containerChanges(mustTask(id), req.signal, requestLocale(req))) satisfies ContainerChanges);
  });
}

// exactly the files and container versions (sha256) the user saw; null = deleted in the container
const schema = z.object({ items: z.array(z.object({ path: z.string().min(1).max(1024), sha: z.string().regex(/^[0-9a-f]{64}$/).nullable() }).strict()).min(1).max(PULL_LIMITS.files) }).strict();

/** Takes the chosen files into the worktree (audited). A file changed in the container since the comparison is refused, like every file the commit checks refuse. */
export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return taskRoute(req, async () => {
    const id = (await params).id;
    const body = await parseJson(req, schema);
    if (!body.ok) return body.res;
    const t = await ready(req, id, true);
    if (t instanceof Response) return t;
    const r = await withTaskLock(id, () => takeOver(mustTask(id), { items: body.data.items }, { via: 'panel', locale: requestLocale(req) }));
    return Response.json({ taken: r.taken, refused: r.refused } satisfies ContainerTakeOver);
  });
}

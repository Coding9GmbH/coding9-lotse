import { z } from 'zod';
import type { PublishResult } from '@/lib/protocol';
import { requestLocale } from '@/lib/i18n/locales';
import { parseJson } from '@/server/http';
import { taskRoute } from '@/server/sandbox/api';
import { PUBLISH_LIMITS, publishTask } from '@/server/sandbox/publish';
import { publicTask } from '@/server/sandbox/tasks';

export const dynamic = 'force-dynamic';

// Title and description only: branch (lotse/…) and base come from the task, whatever else a client sends is refused
const schema = z.object({ title: z.string().max(PUBLISH_LIMITS.title), body: z.string().max(PUBLISH_LIMITS.body).default('') }).strict();

/** "Pull Request erstellen/aktualisieren": commit, push to the task's lotse/… branch, open or update the PR. 409 while the AI works or another publish runs. */
export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return taskRoute(req, async () => {
    const id = (await params).id;
    const body = await parseJson(req, schema);
    if (!body.ok) return body.res;
    const r = await publishTask(id, body.data, requestLocale(req));
    return Response.json({ task: publicTask(r.task), pr: r.pr, action: r.action, files: r.files } satisfies PublishResult);
  });
}

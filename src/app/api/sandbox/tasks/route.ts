import { parseJson } from '@/server/http';
import { taskRoute } from '@/server/sandbox/api';
import { startSandbox, startSchema } from '@/server/sandbox/start';
import { listTasks, publicTask } from '@/server/sandbox/tasks';
import { requestLocale } from '@/lib/i18n/locales';

export const dynamic = 'force-dynamic';

/** Task list (without step logs). */
export function GET(req: Request) {
  return taskRoute(req, async () => Response.json({ tasks: listTasks().map(t => publicTask(t, { logs: false })) }));
}

/** Attach a sandbox to a chat (start.ts): repository access is checked first; the setup starts in the background. One sandbox per chat. */
export function POST(req: Request) {
  return taskRoute(req, async () => {
    const body = await parseJson(req, startSchema);
    if (!body.ok) return body.res;
    const t = await startSandbox(body.data, requestLocale(req));
    return Response.json({ task: publicTask(t) }, { status: 201 });
  });
}

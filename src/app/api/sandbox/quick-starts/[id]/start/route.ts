import { z } from 'zod';
import { chatIdSchema, parseJson } from '@/server/http';
import { taskRoute } from '@/server/sandbox/api';
import { QuickStartBrokenError, startQuickStart } from '@/server/sandbox/quick-starts';
import { publicTask } from '@/server/sandbox/tasks';
import type { QuickStartBroken } from '@/lib/protocol';
import { requestLocale } from '@/lib/i18n/locales';

export const dynamic = 'force-dynamic';

const schema = z.object({ chatId: chatIdSchema, title: z.string().trim().max(120).optional() }).strict();

/** One click on a saved environment: it is checked again and a new sandbox from it is started in this chat (title: the given one, e.g.
 *  from the AI's card, else the environment's name). Not startable as saved (project gone, database deleted, image not allowed …): 422
 *  with the problems and the environment, so the dialog opens prefilled. */
export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return taskRoute(req, async () => {
    const body = await parseJson(req, schema);
    if (!body.ok) return body.res;
    try {
      const { task, warnings } = await startQuickStart((await params).id, body.data.chatId, requestLocale(req), { title: body.data.title });
      return Response.json({ task: publicTask(task), warnings }, { status: 201 });
    } catch (e) {
      if (e instanceof QuickStartBrokenError) return Response.json({ error: e.message, lead: e.lead, problems: e.problems, quickStart: e.quickStart } satisfies QuickStartBroken, { status: 422 });
      throw e;
    }
  });
}

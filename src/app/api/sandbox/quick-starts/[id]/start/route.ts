import { z } from 'zod';
import { chatIdSchema, parseJson } from '@/server/http';
import { taskRoute } from '@/server/sandbox/api';
import { QuickStartBrokenError, startQuickStart } from '@/server/sandbox/quick-starts';
import { publicTask } from '@/server/sandbox/tasks';
import type { QuickStartBroken } from '@/lib/protocol';
import { requestLocale } from '@/lib/i18n/locales';

export const dynamic = 'force-dynamic';

const schema = z.object({ chatId: chatIdSchema }).strict();

/** One click in the "Sandbox" menu: the quick start is checked again and started in this chat. Not startable as saved (project gone,
 *  database deleted, image not allowed …): 422 with the problems and the quick start, so the dialog opens prefilled. */
export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return taskRoute(req, async () => {
    const body = await parseJson(req, schema);
    if (!body.ok) return body.res;
    try {
      const { task, warnings } = await startQuickStart((await params).id, body.data.chatId, requestLocale(req));
      return Response.json({ task: publicTask(task), warnings }, { status: 201 });
    } catch (e) {
      if (e instanceof QuickStartBrokenError) return Response.json({ error: e.message, problems: e.problems, quickStart: e.quickStart } satisfies QuickStartBroken, { status: 422 });
      throw e;
    }
  });
}

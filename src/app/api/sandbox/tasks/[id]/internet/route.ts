import { z } from 'zod';
import { parseJson } from '@/server/http';
import { taskRoute } from '@/server/sandbox/api';
import { grantInternet, revokeInternet } from '@/server/sandbox/internet';
import { mustTask, publicTask } from '@/server/sandbox/tasks';

export const dynamic = 'force-dynamic';

const schema = z.object({ on: z.boolean() }).strict();

/** "Internet: an/aus" in the status line: on = the user allows internet for this task's container, off = "Internet sperren".
 *  Both are audited with the user (internet.ts). The AI never reaches this route: its request_internet only shows a card. */
export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return taskRoute(req, async () => {
    const body = await parseJson(req, schema);
    if (!body.ok) return body.res;
    const id = (await params).id;
    mustTask(id);
    const t = body.data.on ? await grantInternet(id, { via: 'panel' }) : await revokeInternet(id, 'panel');
    return Response.json({ task: publicTask(t ?? mustTask(id)) });
  });
}

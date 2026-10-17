import { jsonError } from '@/server/http';
import { taskRoute } from '@/server/sandbox/api';
import { prStatus } from '@/server/sandbox/publish';
import { mustTask } from '@/server/sandbox/tasks';
import { errMsg } from '@/server/util';

export const dynamic = 'force-dynamic';

/** Live state of the task's pull request on GitHub: open/closed/merged, draft, checks of the head commit (cached 45 s). */
export function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return taskRoute(req, async () => {
    const t = mustTask((await params).id);
    try { return Response.json({ pr: await prStatus(t) }); } catch (e) { return jsonError(502, errMsg(e)); }
  });
}

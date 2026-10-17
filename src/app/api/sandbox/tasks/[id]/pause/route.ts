import { auditTask, taskRoute } from '@/server/sandbox/api';
import { pauseTask } from '@/server/sandbox/jobs';
import { publicTask } from '@/server/sandbox/tasks';

export const dynamic = 'force-dynamic';

/** Pause: stop the container; code, database and changes stay. */
export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return taskRoute(req, async () => {
    const t = await pauseTask((await params).id);
    auditTask(t, 'pause');
    return Response.json({ task: publicTask(t) });
  });
}

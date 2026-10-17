import { auditTask, taskRoute } from '@/server/sandbox/api';
import { finishTask } from '@/server/sandbox/jobs';
import { publicTask } from '@/server/sandbox/tasks';

export const dynamic = 'force-dynamic';

/** "Aufgabe abschließen": remove container, workspace, git dir, dump and screenshots; the task stays as a record. */
export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return taskRoute(req, async () => {
    const t = await finishTask((await params).id);
    auditTask(t, 'finish');
    return Response.json({ task: publicTask(t) });
  });
}

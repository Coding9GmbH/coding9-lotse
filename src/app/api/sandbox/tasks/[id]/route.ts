import { auditTask, taskRoute } from '@/server/sandbox/api';
import { deleteTask } from '@/server/sandbox/jobs';
import { mustTask, publicTask } from '@/server/sandbox/tasks';

export const dynamic = 'force-dynamic';

export function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return taskRoute(req, async () => Response.json({ task: publicTask(mustTask((await params).id)) }));
}

/** Remove the task completely: container, files and the record. */
export function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return taskRoute(req, async () => {
    const t = mustTask((await params).id);
    await deleteTask(t.id);
    auditTask(t, 'delete');
    return Response.json({ ok: true });
  });
}

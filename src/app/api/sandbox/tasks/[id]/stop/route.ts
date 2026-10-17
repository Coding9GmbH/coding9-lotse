import { auditTask, taskRoute } from '@/server/sandbox/api';
import { stopSetup } from '@/server/sandbox/jobs';
import { publicTask } from '@/server/sandbox/tasks';

export const dynamic = 'force-dynamic';

/** Stop the running setup (the container is stopped, retry continues at the interrupted step). */
export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return taskRoute(req, async () => {
    const t = await stopSetup((await params).id);
    auditTask(t, 'stop');
    return Response.json({ task: publicTask(t) });
  });
}

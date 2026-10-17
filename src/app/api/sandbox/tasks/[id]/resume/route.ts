import { auditTask, taskRoute } from '@/server/sandbox/api';
import { startWake } from '@/server/sandbox/jobs';
import { publicTask } from '@/server/sandbox/tasks';

export const dynamic = 'force-dynamic';

/** "Fortsetzen": wake a paused task in the background (start, wait for Shopware, full sync). */
export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return taskRoute(req, async () => {
    const t = await startWake((await params).id);
    auditTask(t, 'resume');
    return Response.json({ task: publicTask(t) });
  });
}

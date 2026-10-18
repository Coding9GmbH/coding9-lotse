import { auditTask, taskRoute } from '@/server/sandbox/api';
import { takeScreenshots } from '@/server/sandbox/screenshots';
import { publicTask } from '@/server/sandbox/tasks';

export const dynamic = 'force-dynamic';

/** "Screenshot" in the preview: captures the configured pages of the running sandbox now (desktop and mobile). Only while
 *  "Screenshots" is switched on in the environment; 409 while the sandbox does not run or another capture runs. */
export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return taskRoute(req, async () => {
    const t = await takeScreenshots((await params).id);
    auditTask(t, 'screenshot');
    return Response.json({ task: publicTask(t) });
  });
}

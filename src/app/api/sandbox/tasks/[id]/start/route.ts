import { z } from 'zod';
import { parseJson } from '@/server/http';
import { auditTask, taskRoute } from '@/server/sandbox/api';
import { runSteps } from '@/server/sandbox/jobs';
import { publicTask } from '@/server/sandbox/tasks';

export const dynamic = 'force-dynamic';

const schema = z.object({ fromStep: z.string().max(80).optional() }).strict();

/** Start or retry the setup, by default from the first step not done ("Ab hier erneut versuchen" passes the step). */
export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return taskRoute(req, async () => {
    const body = await parseJson(req, schema);
    if (!body.ok) return body.res;
    const t = runSteps((await params).id, body.data.fromStep);
    auditTask(t, 'start', body.data.fromStep ? { fromStep: body.data.fromStep } : {});
    return Response.json({ task: publicTask(t) }, { status: 202 });
  });
}

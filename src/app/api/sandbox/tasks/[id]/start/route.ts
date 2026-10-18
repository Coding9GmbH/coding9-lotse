import { z } from 'zod';
import { parseJson } from '@/server/http';
import { auditTask, taskRoute } from '@/server/sandbox/api';
import { runSteps } from '@/server/sandbox/jobs';
import { publicTask } from '@/server/sandbox/tasks';

export const dynamic = 'force-dynamic';

const schema = z.object({ fromStep: z.string().max(80).optional(), ignoreVersion: z.boolean().optional() }).strict();

/** Start or retry the setup, by default from the first step not done ("Ab hier erneut versuchen" passes the step).
 *  ignoreVersion: "Trotzdem fortfahren" after the version check refused the dump (fromStep version-check) or the project's Shopware
 *  version (fromStep detect-layout). */
export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return taskRoute(req, async () => {
    const body = await parseJson(req, schema);
    if (!body.ok) return body.res;
    const t = runSteps((await params).id, body.data.fromStep, { ignoreVersion: body.data.ignoreVersion });
    auditTask(t, 'start', { ...(body.data.fromStep ? { fromStep: body.data.fromStep } : {}), ...(body.data.ignoreVersion ? { ignoreVersion: true } : {}) });
    return Response.json({ task: publicTask(t) }, { status: 202 });
  });
}

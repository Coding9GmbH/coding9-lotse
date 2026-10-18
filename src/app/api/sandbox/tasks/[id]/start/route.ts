import { z } from 'zod';
import { requestLocale } from '@/lib/i18n/locales';
import { parseJson } from '@/server/http';
import { auditTask, taskRoute } from '@/server/sandbox/api';
import { assertLocalWorkKept, runSteps } from '@/server/sandbox/jobs';
import { publicTask } from '@/server/sandbox/tasks';

export const dynamic = 'force-dynamic';

const schema = z.object({ fromStep: z.string().max(80).optional(), ignoreVersion: z.boolean().optional() }).strict();

/** Start or retry the setup, by default from the first step not done ("Ab hier erneut versuchen" passes the step).
 *  ignoreVersion: "Trotzdem fortfahren" after the version check refused the dump (fromStep version-check) or the project's Shopware
 *  version (fromStep detect-layout). A sandbox without a project keeps its local work: no new start from "Repository klonen" then. */
export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return taskRoute(req, async () => {
    const body = await parseJson(req, schema);
    if (!body.ok) return body.res;
    const id = (await params).id;
    await assertLocalWorkKept(id, body.data.fromStep, requestLocale(req)); // a sandbox without a project: its work is only here
    const t = runSteps(id, body.data.fromStep, { ignoreVersion: body.data.ignoreVersion });
    auditTask(t, 'start', { ...(body.data.fromStep ? { fromStep: body.data.fromStep } : {}), ...(body.data.ignoreVersion ? { ignoreVersion: true } : {}) });
    return Response.json({ task: publicTask(t) }, { status: 202 });
  });
}

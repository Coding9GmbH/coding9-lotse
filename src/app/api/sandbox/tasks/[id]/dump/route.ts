import { z } from 'zod';
import { parseJson } from '@/server/http';
import { auditTask } from '@/server/sandbox/api';
import { dumpRoute } from '@/server/sandbox/dump-route';
import { runSteps } from '@/server/sandbox/jobs';
import { publicTask } from '@/server/sandbox/tasks';

export const dynamic = 'force-dynamic';

const schema = z.object({ dumpId: z.string().max(40) }).strict();

/** "Datenbank ersetzen": the uploaded dump becomes the task's dump; the setup runs again from the version check. */
export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return dumpRoute(req, async () => {
    const body = await parseJson(req, schema);
    if (!body.ok) return body.res;
    const t = runSteps((await params).id, undefined, { dumpId: body.data.dumpId });
    auditTask(t, 'replace-db', { dump: t.dump?.name });
    return Response.json({ task: publicTask(t) }, { status: 202 });
  });
}

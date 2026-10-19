import { z } from 'zod';
import { errMsg, jsonError, parseJson } from '@/server/http';
import { auditAdd } from '@/server/db';
import { taskRoute } from '@/server/sandbox/api';
import { saveShopwareToken } from '@/server/sandbox/composer-auth';
import { mustTask } from '@/server/sandbox/tasks';

export const dynamic = 'force-dynamic';

const schema = z.object({ token: z.string().max(2000) }).strict();

/** The setup's composer install was refused by packages.shopware.com (or a private package): stores the entered token as the secret
 *  variable COMPOSER_AUTH of the sandbox environment. The client then retries the failed step (POST …/start with fromStep). */
export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return taskRoute(req, async () => {
    const body = await parseJson(req, schema);
    if (!body.ok) return body.res;
    const t = mustTask((await params).id);
    try { saveShopwareToken(body.data.token); } catch (e) { return jsonError(400, errMsg(e)); }
    auditAdd({ decision: 'changed', kind: 'settings', title: 'Sandbox-Umgebung geändert', fields: { 'env.COMPOSER_AUTH': 'geändert' }, taskId: t.id }); // names only, never value
    return Response.json({ ok: true });
  });
}

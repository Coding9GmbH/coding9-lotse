import { z } from 'zod';
import { parseJson } from '@/server/http';
import { taskRoute } from '@/server/sandbox/api';
import { deleteQuickStart, getQuickStart, updateQuickStart } from '@/server/sandbox/quick-starts';
import { requestLocale } from '@/lib/i18n/locales';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };
const schema = z.object({ name: z.string().max(200).optional(), setup: z.unknown().optional(), isDefault: z.boolean().optional() }).strict();

export function GET(req: Request, { params }: Ctx) {
  return taskRoute(req, async () => Response.json({ quickStart: getQuickStart((await params).id, requestLocale(req)) }));
}

/** Rename, edit (the dialog's request again) or mark as default / unmark. */
export function PATCH(req: Request, { params }: Ctx) {
  return taskRoute(req, async () => {
    const body = await parseJson(req, schema);
    if (!body.ok) return body.res;
    return Response.json({ quickStart: updateQuickStart((await params).id, body.data, requestLocale(req)) });
  });
}

export function DELETE(req: Request, { params }: Ctx) {
  return taskRoute(req, async () => { deleteQuickStart((await params).id, requestLocale(req)); return Response.json({ ok: true }); });
}

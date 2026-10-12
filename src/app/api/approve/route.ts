import { z } from 'zod';
import { chatIdSchema, jsonError, parseJson } from '@/server/http';
import { decideChange } from '@/server/sessions';

export const dynamic = 'force-dynamic';

const schema = z.object({ chatId: chatIdSchema, approvalId: z.string().min(1, 'approvalId fehlt'), allow: z.boolean(), selected: z.array(z.string()).optional() });

export async function POST(req: Request) {
  const body = await parseJson(req, schema);
  if (!body.ok) return body.res;
  const { chatId, approvalId, allow, selected } = body.data;
  if (!decideChange(chatId, approvalId, allow, selected)) return jsonError(404, 'unknown approval');
  return Response.json({ ok: true });
}

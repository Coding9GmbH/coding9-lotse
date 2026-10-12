import { z } from 'zod';
import { chatIdSchema, jsonError, parseJson } from '@/server/http';
import { answerQuestion } from '@/server/sessions';

export const dynamic = 'force-dynamic';

const schema = z.object({ chatId: chatIdSchema, approvalId: z.string().min(1, 'approvalId fehlt'), answer: z.string().max(10_000) });

export async function POST(req: Request) {
  const body = await parseJson(req, schema);
  if (!body.ok) return body.res;
  const { chatId, approvalId, answer } = body.data;
  if (!answerQuestion(chatId, approvalId, answer)) return jsonError(404, 'unknown question');
  return Response.json({ ok: true });
}

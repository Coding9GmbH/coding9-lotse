import { z } from 'zod';
import { chatIdSchema, parseJson } from '@/server/http';
import { dropSession } from '@/server/sessions';

export const dynamic = 'force-dynamic';

const schema = z.object({ chatId: chatIdSchema });

// Verlauf bleibt auf Platte erhalten
export async function POST(req: Request) {
  const body = await parseJson(req, schema);
  if (!body.ok) return body.res;
  dropSession(body.data.chatId);
  return Response.json({ ok: true });
}

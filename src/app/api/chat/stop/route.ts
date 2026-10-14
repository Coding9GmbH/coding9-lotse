import { z } from 'zod';
import { chatIdSchema, parseJson } from '@/server/http';
import { stopChat } from '@/server/sessions';

export const dynamic = 'force-dynamic';

// Abort the running turn (open questions/approvals count as declined; nothing is written).
export async function POST(req: Request) {
  const body = await parseJson(req, z.object({ chatId: chatIdSchema }));
  if (!body.ok) return body.res;
  return Response.json({ stopped: stopChat(body.data.chatId) });
}

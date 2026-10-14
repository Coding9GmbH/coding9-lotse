import { z } from 'zod';
import { actorFromRequest, noteChatActor, withActor } from '@/server/actor';
import { chatIdSchema, jsonError, parseJson } from '@/server/http';
import { undoChangeSet } from '@/server/sessions';
import { recheckShopCheck } from '@/server/shopcheck';

export const dynamic = 'force-dynamic';

const schema = z.object({ chatId: chatIdSchema, csId: z.string().min(1, 'csId fehlt') });

// Undo: user-initiated (click) → restores the stored before values
export async function POST(req: Request) {
  const body = await parseJson(req, schema);
  if (!body.ok) return body.res;
  const actor = actorFromRequest(req); noteChatActor(body.data.chatId, actor);
  const out = await withActor(actor, () => undoChangeSet(body.data.chatId, body.data.csId));
  if (!out) return jsonError(400, 'Nichts rückgängig zu machen');
  if (out.results.some(r => r.ok)) void recheckShopCheck(); // reverted values can bring findings back
  return Response.json(out);
}

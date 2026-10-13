import { z } from 'zod';
import { chatIdSchema, jsonError, parseJson } from '@/server/http';
import { undoChangeSet } from '@/server/sessions';
import { recheckShopCheck } from '@/server/shopcheck';

export const dynamic = 'force-dynamic';

const schema = z.object({ chatId: chatIdSchema, csId: z.string().min(1, 'csId fehlt') });

// Rückgängig: nutzerinitiiert (Klick) → stellt die gespeicherten Vorher-Werte wieder her
export async function POST(req: Request) {
  const body = await parseJson(req, schema);
  if (!body.ok) return body.res;
  const out = await undoChangeSet(body.data.chatId, body.data.csId);
  if (!out) return jsonError(400, 'Nichts rückgängig zu machen');
  if (out.results.some(r => r.ok)) void recheckShopCheck(); // zurückgesetzte Werte können Befunde zurückbringen
  return Response.json(out);
}

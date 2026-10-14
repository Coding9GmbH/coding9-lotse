import { z } from 'zod';
import { requestLocale } from '@/lib/i18n/locales';
import { startChat } from '@/server/agent';
import { listenStream } from '@/server/chat-stream';
import { chatIdSchema, jsonError, parseJson } from '@/server/http';
import { chatSnapshot, getSession, peekSession } from '@/server/sessions';
import { refreshDraftPreview } from '@/server/tools';

export const dynamic = 'force-dynamic';

const target = z.object({
  kind: z.enum(['category', 'product', 'landing']),
  id: z.string().optional(), name: z.string().optional(), path: z.string().nullable().optional(), cmsPage: z.string().nullable().optional(),
});
const schema = z.object({ chatId: chatIdSchema, message: z.string().min(1, 'message fehlt').max(100_000), target: target.nullable().optional(), onboarding: z.boolean().optional() });

// Start a new turn; response as an NDJSON stream (one JSON line per event). If the client leaves the chat,
// the turn keeps running in the background, and the client can reconnect via GET.
export async function POST(req: Request) {
  const body = await parseJson(req, schema);
  if (!body.ok) return body.res;
  const s = getSession(body.data.chatId);
  if (s.running) return jsonError(409, 'In diesem Chat läuft schon eine Anfrage.');
  // Listen first, then start, so no event is lost
  const res = listenStream(s, [], true);
  startChat({ ...body.data, locale: requestLocale(req) });
  return res;
}

// Reconnect: first the history so far ("snapshot"), then (if the turn is still running) the live events.
export async function GET(req: Request) {
  const id = chatIdSchema.safeParse(new URL(req.url).searchParams.get('chatId'));
  if (!id.success) return jsonError(400, 'chatId fehlt');
  if (!chatSnapshot(id.data)) return jsonError(404, 'not found'); // don't create a session for unknown IDs
  await refreshDraftPreview(getSession(id.data)); // old drafts in the current look
  const chat = chatSnapshot(id.data)!;
  const s = peekSession(id.data);
  const running = !!s?.running;
  return listenStream(s ?? getSession(id.data), [{ t: 'snapshot', chat, running }], running);
}

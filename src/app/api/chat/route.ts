import { z } from 'zod';
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

// Neue Runde starten; Antwort als NDJSON-Stream (eine JSON-Zeile je Ereignis). Verlässt der Client den Chat,
// läuft die Runde im Hintergrund weiter – er kann sich über GET wieder verbinden.
export async function POST(req: Request) {
  const body = await parseJson(req, schema);
  if (!body.ok) return body.res;
  const s = getSession(body.data.chatId);
  if (s.running) return jsonError(409, 'In diesem Chat läuft schon eine Anfrage.');
  // Erst zuhören, dann starten – so geht kein Ereignis verloren
  const res = listenStream(s, [], true);
  startChat(body.data);
  return res;
}

// Wieder verbinden: erst der bisherige Verlauf („snapshot“), dann – falls die Runde noch läuft – die Live-Ereignisse.
export async function GET(req: Request) {
  const id = chatIdSchema.safeParse(new URL(req.url).searchParams.get('chatId'));
  if (!id.success) return jsonError(400, 'chatId fehlt');
  if (!chatSnapshot(id.data)) return jsonError(404, 'not found'); // keine Session für unbekannte IDs anlegen
  await refreshDraftPreview(getSession(id.data)); // alte Entwürfe im aktuellen Look
  const chat = chatSnapshot(id.data)!;
  const s = peekSession(id.data);
  const running = !!s?.running;
  return listenStream(s ?? getSession(id.data), [{ t: 'snapshot', chat, running }], running);
}

import { CHAT_PAGE, chatList } from '@/server/db';
import { chatListLive, chatStatus, peekSession } from '@/server/sessions';

export const dynamic = 'force-dynamic';

// Ohne Parameter wie bisher: die neuesten 200 Chats. Weiterblättern: ?before=<updatedAt>&beforeId=<id> (letzte Zeile der vorigen Seite),
// Titelsuche: ?q=…, Seitengröße: ?limit= (höchstens 200). Antwort immer ein Array; volle Seite = es gibt vielleicht mehr.
export function GET(req: Request) {
  const p = new URL(req.url).searchParams, before = p.get('before'), q = p.get('q')?.slice(0, 200) || null, limit = Number(p.get('limit')) || CHAT_PAGE;
  if (!before && !q && limit === CHAT_PAGE) return Response.json(chatListLive());
  return Response.json(chatList({ limit, q, before: before ? { updatedAt: before, id: p.get('beforeId') ?? '' } : null }).map(c => {
    const status = chatStatus(peekSession(c.id));
    return status ? { ...c, status } : c;
  }));
}

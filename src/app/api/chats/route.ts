import { CHAT_PAGE, chatList } from '@/server/db';
import { chatListLive, chatStatus, peekSession } from '@/server/sessions';

export const dynamic = 'force-dynamic';

// Without parameters as before: the newest 200 chats. Paging: ?before=<updatedAt>&beforeId=<id> (last row of the previous page),
// title search: ?q=…, page size: ?limit= (at most 200). Response is always an array; full page = there may be more.
export function GET(req: Request) {
  const p = new URL(req.url).searchParams, before = p.get('before'), q = p.get('q')?.slice(0, 200) || null, limit = Number(p.get('limit')) || CHAT_PAGE;
  if (!before && !q && limit === CHAT_PAGE) return Response.json(chatListLive());
  return Response.json(chatList({ limit, q, before: before ? { updatedAt: before, id: p.get('beforeId') ?? '' } : null }).map(c => {
    const status = chatStatus(peekSession(c.id));
    return status ? { ...c, status } : c;
  }));
}

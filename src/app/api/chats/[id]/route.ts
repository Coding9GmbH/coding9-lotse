import type { ChatDetail } from '@/lib/protocol';
import { chatDelete } from '@/server/db';
import { jsonError } from '@/server/http';
import { chatSnapshot, dropSession, peekSession } from '@/server/sessions';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = chatSnapshot(id);
  if (!c) return jsonError(404, 'not found');
  const out: ChatDetail = { ...c, running: !!peekSession(id)?.running };
  return Response.json(out);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  chatDelete(id); dropSession(id);
  return Response.json({ ok: true });
}

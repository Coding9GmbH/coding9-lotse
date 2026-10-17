import type { ChatDetail } from '@/lib/protocol';
import { clearMcpToken } from '@/server/codex';
import { chatDelete } from '@/server/db';
import { log } from '@/server/log';
import { finishTask } from '@/server/sandbox/jobs';
import { attachedTask } from '@/server/sandbox/tasks';
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
  // an attached sandbox is finished with the chat (container and workspace removed); the task stays as a record in "Sandbox Coding"
  const t = attachedTask(id);
  if (t) await finishTask(t.id).catch(e => log.warn('Sandbox des Chats nicht abgeschlossen', { task: t.id, error: e }));
  chatDelete(id); dropSession(id); clearMcpToken(id);
  return Response.json({ ok: true });
}

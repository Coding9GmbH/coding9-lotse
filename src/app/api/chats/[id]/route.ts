import type { ChatDetail } from '@/lib/protocol';
import { clearMcpToken } from '@/server/codex';
import { chatDelete, codeTaskByChat } from '@/server/db';
import { log } from '@/server/log';
import { deleteTask } from '@/server/sandbox/jobs';
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
  // a code chat takes its task along (container, workspace, record)
  for (const taskId of codeTaskByChat(id)) await deleteTask(taskId).catch(e => log.warn('Sandbox-Aufgabe des Chats nicht gelöscht', { task: taskId, error: e }));
  chatDelete(id); dropSession(id); clearMcpToken(id);
  return Response.json({ ok: true });
}

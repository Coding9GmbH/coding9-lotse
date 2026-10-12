import { z } from 'zod';
import { TITLE_MAX } from '@/lib/knowledge';
import { errMsg, jsonError, parseJson } from '@/server/http';
import { deleteDoc, updateDoc } from '@/server/knowledge';
import { linkSchema } from '../../schema';

export const dynamic = 'force-dynamic';

const schema = z.object({ title: z.string().max(TITLE_MAX).optional(), tags: z.array(z.string()).max(20).optional(), links: z.array(linkSchema).max(200).optional() });

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await parseJson(req, schema);
  if (!body.ok) return body.res;
  try { return Response.json(updateDoc(id, body.data)); } catch (e) { return jsonError(404, errMsg(e)); }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return deleteDoc(id) ? Response.json({ ok: true }) : jsonError(404, 'Dokument nicht gefunden');
}

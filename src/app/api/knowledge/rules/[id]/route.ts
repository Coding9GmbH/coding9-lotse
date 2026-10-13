import { z } from 'zod';
import { RULE_MAX } from '@/lib/knowledge';
import { errMsg, jsonError, parseJson } from '@/server/http';
import { removeRule, updateRule } from '@/server/knowledge';

export const dynamic = 'force-dynamic';

const schema = z.object({ text: z.string().min(1).max(RULE_MAX).optional(), scope: z.enum(['all', 'products', 'pages', 'seo']).optional(), target: z.object({ id: z.string().min(1).max(100), name: z.string().max(200).optional() }).nullable().optional() });

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await parseJson(req, schema);
  if (!body.ok) return body.res;
  try { return Response.json(updateRule(id, body.data)); } catch (e) { return jsonError(400, errMsg(e)); }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return removeRule(id) ? Response.json({ ok: true }) : jsonError(404, 'Regel nicht gefunden');
}

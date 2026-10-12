import { z } from 'zod';
import { RULE_MAX } from '@/lib/knowledge';
import { errMsg, jsonError, parseJson } from '@/server/http';
import { addRule } from '@/server/knowledge';

export const dynamic = 'force-dynamic';

const schema = z.object({ text: z.string().min(1).max(RULE_MAX), scope: z.enum(['all', 'products', 'pages', 'seo']).optional() });

export async function POST(req: Request) {
  const body = await parseJson(req, schema);
  if (!body.ok) return body.res;
  try { return Response.json(addRule(body.data.text, body.data.scope)); } catch (e) { return jsonError(400, errMsg(e)); }
}

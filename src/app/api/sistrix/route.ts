import { z } from 'zod';
import { errMsg, jsonError, parseJson } from '@/server/http';
import { saveSistrix, sistrixPublic } from '@/server/features/sistrix-api';

export const dynamic = 'force-dynamic';

// Sistrix: API key only goes in, never out. All that comes back is whether one is stored.
const schema = z.object({ key: z.string().max(200).optional(), domain: z.string().max(300).optional(), country: z.string().max(10).optional(), project: z.string().max(100).optional() });

export function GET() {
  return Response.json(sistrixPublic());
}

export async function PUT(req: Request) {
  const body = await parseJson(req, schema);
  if (!body.ok) return body.res;
  try { saveSistrix(body.data); } catch (e) { return jsonError(400, errMsg(e)); }
  return Response.json(sistrixPublic());
}

export function DELETE() {
  saveSistrix({ key: null });
  return Response.json(sistrixPublic());
}

import { z } from 'zod';
import { errMsg, jsonError, parseJson } from '@/server/http';
import { gscPublic, saveGsc } from '@/server/features/gsc-google';

export const dynamic = 'force-dynamic';

// Google Search Console: Schlüssel (JSON des Service-Kontos) nur hinein, nie heraus. Zurück kommt nur client_email.
const schema = z.object({ key: z.string().max(20_000).optional(), property: z.string().max(500).optional() });

export function GET() {
  return Response.json(gscPublic());
}

export async function PUT(req: Request) {
  const body = await parseJson(req, schema);
  if (!body.ok) return body.res;
  try { saveGsc(body.data); } catch (e) { return jsonError(400, errMsg(e)); }
  return Response.json(gscPublic());
}

export function DELETE() {
  saveGsc({ key: null });
  return Response.json(gscPublic());
}

import type { NextRequest } from 'next/server';
import { errMsg, jsonError, readBodyLimited } from '@/server/http';
import { FILE_LIMIT, saveFile } from '@/server/files';

export const dynamic = 'force-dynamic';

// Raw file in the body, file name as query parameter (type is detected from the extension)
export async function POST(req: NextRequest) {
  const name = String(req.nextUrl.searchParams.get('name') || '');
  const buf = await readBodyLimited(req, FILE_LIMIT);
  if (!buf) return jsonError(413, 'Datei größer als 25 MB');
  try { return Response.json(saveFile(buf, name)); } catch (e) { return jsonError(400, errMsg(e)); }
}

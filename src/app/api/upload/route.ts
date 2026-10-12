import type { NextRequest } from 'next/server';
import { errMsg, jsonError, readBodyLimited } from '@/server/http';
import { stageImage } from '@/server/media';

export const dynamic = 'force-dynamic';

const LIMIT = 25 * 1024 * 1024;

// Rohes Bild im Body (content-type image/*), Name/Alt-Text als Query-Parameter
export async function POST(req: NextRequest) {
  const mime = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!mime.startsWith('image/')) return jsonError(400, `Bildtyp ${mime || 'unbekannt'} wird nicht unterstützt`);
  const buf = await readBodyLimited(req, LIMIT);
  if (!buf) return jsonError(413, 'Bild größer als 25 MB');
  try {
    const q = req.nextUrl.searchParams;
    const name = String(q.get('name') || 'upload').replace(/\.[a-z0-9]+$/i, '');
    // Auf allen Plattformen nur lokal vormerken (staged:…): in den Shop kommt das Bild erst, wenn ein freigegebenes Änderungsset es verwendet
    return Response.json(stageImage(buf, mime, { name, alt: q.get('alt') || name }));
  } catch (e) { return jsonError(400, errMsg(e)); }
}

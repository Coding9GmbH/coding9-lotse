import type { NextRequest } from 'next/server';
import { errMsg, jsonError, readBodyLimited } from '@/server/http';
import { IMAGE_TOO_LARGE, MAX_IMAGE_BYTES, sanitizeSvg, stageImage } from '@/server/media';

export const dynamic = 'force-dynamic';

// Raw image in the body (content-type image/*), name/alt text as query parameters
export async function POST(req: NextRequest) {
  const mime = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!mime.startsWith('image/')) return jsonError(400, `Bildtyp ${mime || 'unbekannt'} wird nicht unterstützt`);
  const buf = await readBodyLimited(req, MAX_IMAGE_BYTES); // same limit as stageImage (documents: /api/files with FILE_LIMIT)
  if (!buf) return jsonError(413, IMAGE_TOO_LARGE);
  try {
    const q = req.nextUrl.searchParams;
    const name = String(q.get('name') || 'upload').replace(/\.[a-z0-9]+$/i, '');
    // Check SVG before staging. sanitizeSvg rejects scripts, handlers and external references and throws; the catch responds 400.
    let bytes = buf;
    if (mime === 'image/svg+xml') bytes = Buffer.from(sanitizeSvg(buf.toString('utf8')));
    // Only stage locally on all platforms (staged:…): the image reaches the shop only when an approved change set uses it
    return Response.json(stageImage(bytes, mime, { name, alt: q.get('alt') || name }));
  } catch (e) { return jsonError(400, errMsg(e)); }
}

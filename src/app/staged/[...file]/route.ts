import fs from 'node:fs/promises';
import { stagedFile } from '@/server/media';

export const dynamic = 'force-dynamic';

// Serve the AI's staged (not yet uploaded) images: only image files directly in the staging folder
export async function GET(_req: Request, { params }: { params: Promise<{ file: string[] }> }) {
  const f = stagedFile((await params).file);
  if (!f) return new Response('Not Found', { status: 404 });
  let buf: Buffer;
  try { buf = await fs.readFile(f.path); } catch { return new Response('Not Found', { status: 404 }); }
  return new Response(new Uint8Array(buf), { headers: { 'content-type': f.mime, 'cache-control': 'public, max-age=0', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" } });
}

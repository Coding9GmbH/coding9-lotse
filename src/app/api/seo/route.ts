import { seoOverview } from '@/server/features/seo-overview';
import { activePlatform } from '@/server/platform';
import { errMsg, jsonError } from '@/server/http';

export const dynamic = 'force-dynamic';

// SEO-Übersicht: lesend (geschützter Lese-Client, Zugriffsprotokoll unter „seo“), Quellen sind gedeckelt und zwischengespeichert
export async function GET() {
  try {
    const p = activePlatform();
    if (!p.configured()) return Response.json({ gsc: false, sistrix: false, items: [], errors: [], generatedAt: new Date().toISOString() });
    return Response.json(await seoOverview(p.openSession('seo').lookup));
  } catch (e) { return jsonError(500, errMsg(e)); }
}

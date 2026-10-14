import { seoOverviewCached, seoOverviewStored } from '@/server/features/seo-overview';
import { activePlatform } from '@/server/platform';
import { errMsg, jsonError } from '@/server/http';

export const dynamic = 'force-dynamic';

// SEO-Übersicht: lesend (geschützter Lese-Client, Zugriffsprotokoll unter „seo“). Das Ergebnis liegt gespeichert vor;
// ?refresh=1 holt an allen Zwischenspeichern vorbei neu (kostet Sistrix-Credits), ?stored=1 liefert nur Gespeichertes (Arbeitsfläche, nie Credits).
export async function GET(req: Request) {
  try {
    const q = new URL(req.url).searchParams;
    if (q.get('stored') === '1') return Response.json(seoOverviewStored());
    const p = activePlatform();
    if (!p.configured()) return Response.json({ gsc: false, sistrix: false, items: [], errors: [], generatedAt: new Date().toISOString() });
    return Response.json(await seoOverviewCached(p.openSession('seo').lookup, q.get('refresh') === '1'));
  } catch (e) { return jsonError(500, errMsg(e)); }
}

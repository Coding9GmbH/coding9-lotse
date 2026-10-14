import { seoOverviewCached, seoOverviewStored } from '@/server/features/seo-overview';
import { activePlatform } from '@/server/platform';
import { errMsg, jsonError } from '@/server/http';

export const dynamic = 'force-dynamic';

// SEO overview: read-only (protected read client, access log under "seo"). The result is stored;
// ?refresh=1 refetches bypassing all caches (costs Sistrix credits), ?stored=1 returns only stored data (workspace, never credits).
export async function GET(req: Request) {
  try {
    const q = new URL(req.url).searchParams;
    if (q.get('stored') === '1') return Response.json(seoOverviewStored());
    const p = activePlatform();
    if (!p.configured()) return Response.json({ gsc: false, sistrix: false, items: [], errors: [], generatedAt: new Date().toISOString() });
    return Response.json(await seoOverviewCached(p.openSession('seo').lookup, q.get('refresh') === '1', { storefront: p.storefront, label: p.label }));
  } catch (e) { return jsonError(500, errMsg(e)); }
}

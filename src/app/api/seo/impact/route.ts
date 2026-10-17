import { z } from 'zod';
import { dismissImpact, impactList, measureOpen } from '@/server/features/gsc';
import { getGscConfig } from '@/server/features/gsc-google';
import { activePlatform } from '@/server/platform';
import { getSettings } from '@/server/settings';
import { errMsg, jsonError, parseJson } from '@/server/http';
import type { SeoImpactList } from '@/lib/protocol';

export const dynamic = 'force-dynamic';

// Impact of applied changes (Search Console). GET only shows the stored state (no request to Google);
// POST measures all open changes that already have enough days; PUT hides/shows one measurement. Nothing is written to the shop.
const connected = () => !!getGscConfig() && getSettings().scopes.gsc !== false;
const list = (): SeoImpactList => (connected() ? { connected: true, items: impactList() } : { connected: false, items: [] });

export async function GET() {
  return Response.json(list());
}

export async function POST() {
  try {
    const cfg = getGscConfig();
    if (!cfg || getSettings().scopes.gsc === false) return jsonError(409, 'Search Console ist nicht verbunden oder für die KI ausgeschaltet.');
    const p = activePlatform();
    if (!p.configured()) return jsonError(409, 'Kein Shop verbunden.');
    const r = await measureOpen(cfg, p.openSession('seo').lookup);
    return Response.json({ ...list(), measured: r.measured, failed: r.failed });
  } catch (e) { return jsonError(500, errMsg(e)); }
}

const schema = z.object({ id: z.string().min(1).max(100), dismissed: z.boolean() });
export async function PUT(req: Request) {
  const body = await parseJson(req, schema);
  if (!body.ok) return body.res;
  if (!dismissImpact(body.data.id, body.data.dismissed)) return jsonError(404, 'Messung nicht gefunden');
  return Response.json(list());
}

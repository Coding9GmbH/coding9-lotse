import type { SistrixOverview } from '@/lib/protocol';
import { errMsg } from '@/server/http';
import { getSistrixConfig } from '@/server/features/sistrix-api';
import { visibilityOverview } from '@/server/features/sistrix';

export const dynamic = 'force-dynamic';

// Home page card: visibility history of the shop domain (read-only, capped, cached for a long time)
export async function GET() {
  const cfg = getSistrixConfig();
  if (!cfg?.domain) return Response.json({ connected: false } satisfies SistrixOverview);
  try { return Response.json({ connected: true, ...(await visibilityOverview(cfg)) } satisfies SistrixOverview); }
  catch (e) { return Response.json({ connected: true, domain: cfg.domain, error: errMsg(e).replace(/\s+/g, ' ').slice(0, 300) } satisfies SistrixOverview); }
}

import type { Health } from '@/lib/protocol';
import { activePlatform } from '@/server/platform';
import { aiConfigured, getSettings } from '@/server/settings';
import { gscConnected } from '@/server/features/gsc-google';
import { sistrixConnected } from '@/server/features/sistrix-api';
import { usageStatus } from '@/server/usage';

export const dynamic = 'force-dynamic';

export async function GET() {
  const p = activePlatform();
  const sh = await p.health(), scopes = getSettings().scopes, u = usageStatus();
  const out: Health = {
    shopware: { url: sh.url, ok: sh.ok, configured: p.configured(), ...(sh.error ? { error: sh.error } : {}) },
    ai: { configured: aiConfigured(), provider: getSettings().ai.provider, ...(u.budget && u.provider === 'claude' ? { budget: { spent: u.month.cost, limit: u.budget, warn: u.warn, blocked: u.blocked } } : {}) },
    platform: { kind: p.kind, label: p.label, available: p.settings.available },
    integrations: { gsc: gscConnected() && scopes.gsc !== false, sistrix: sistrixConnected() && scopes.sistrix !== false },
  };
  return Response.json(out);
}

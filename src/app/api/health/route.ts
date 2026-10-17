import type { Health } from '@/lib/protocol';
import { activePlatform } from '@/server/platform';
import { aiConfigured, getSettings } from '@/server/settings';
import { gscConnected } from '@/server/features/gsc-google';
import { sistrixConnected } from '@/server/features/sistrix-api';
import { githubConnected } from '@/server/github';
import { budgetBrief } from '@/server/usage';

export const dynamic = 'force-dynamic';

export async function GET() {
  const p = activePlatform();
  const sh = await p.health(), scopes = getSettings().scopes, budget = budgetBrief();
  const out: Health = {
    shopware: { url: sh.url, ok: sh.ok, configured: p.configured(), ...(sh.error ? { error: sh.error } : {}) },
    ai: { configured: aiConfigured(), provider: getSettings().ai.provider, ...(budget ? { budget } : {}) },
    platform: { kind: p.kind, label: p.label, available: p.settings.available },
    integrations: { gsc: gscConnected() && scopes.gsc !== false, sistrix: sistrixConnected() && scopes.sistrix !== false, github: githubConnected() },
  };
  return Response.json(out);
}

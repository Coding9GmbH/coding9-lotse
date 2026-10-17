import type { Health } from '@/lib/protocol';
import { activePlatform } from '@/server/platform';
import { aiConfigured, getSettings } from '@/server/settings';
import { gscConnected } from '@/server/features/gsc-google';
import { sistrixConnected } from '@/server/features/sistrix-api';
import { githubConnected } from '@/server/github';
import { budgetBrief } from '@/server/usage';
import { dockerState, sandboxPublic } from '@/server/sandbox/env';

export const dynamic = 'force-dynamic';

export async function GET() {
  const p = activePlatform();
  const sh = await p.health(), scopes = getSettings().scopes, budget = budgetBrief(), sbx = sandboxPublic();
  const out: Health = {
    shopware: { url: sh.url, ok: sh.ok, configured: p.configured(), ...(sh.error ? { error: sh.error } : {}) },
    ai: { configured: aiConfigured(), provider: getSettings().ai.provider, ...(budget ? { budget } : {}) },
    platform: { kind: p.kind, label: p.label, available: p.settings.available },
    integrations: { gsc: gscConnected() && scopes.gsc !== false, sistrix: sistrixConnected() && scopes.sistrix !== false, github: githubConnected() },
    sandbox: { enabled: sbx.status.enabled, docker: sbx.status.enabled ? (await dockerState()).reachable : null, github: githubConnected(), image: sbx.status.enabled ? sbx.image : null },
  };
  return Response.json(out);
}

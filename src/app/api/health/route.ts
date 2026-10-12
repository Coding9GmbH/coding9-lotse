import type { Health } from '@/lib/protocol';
import { activePlatform } from '@/server/platform';
import { aiConfigured, getSettings } from '@/server/settings';

export const dynamic = 'force-dynamic';

export async function GET() {
  const p = activePlatform();
  const sh = await p.health();
  const out: Health = {
    shopware: { url: sh.url, ok: sh.ok, configured: p.configured(), ...(sh.error ? { error: sh.error } : {}) },
    ai: { configured: aiConfigured(), provider: getSettings().ai.provider },
    platform: { kind: p.kind, label: p.label, available: p.settings.available },
  };
  return Response.json(out);
}

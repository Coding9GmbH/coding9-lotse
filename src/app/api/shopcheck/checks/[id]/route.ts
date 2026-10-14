import { z } from 'zod';
import { CUSTOM_PREFIX } from '@/lib/custom-checks';
import { jsonError, parseJson } from '@/server/http';
import { checkList, listCustom, removeCustom, setCheckEnabled } from '@/server/custom-checks';
import { activePlatform } from '@/server/platform';
import { recheckShopCheck } from '@/server/shopcheck';

export const dynamic = 'force-dynamic';

const schema = z.object({ enabled: z.boolean() });

async function known(id: string) {
  const p = activePlatform();
  await import('@/server/features'); await p.loadChecks();
  return checkList(p.kind).some(c => c.id === id);
}

// Toggle on/off (built-in or custom); then re-check in the background so the home page is accurate
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await parseJson(req, schema);
  if (!body.ok) return body.res;
  if (!(await known(id))) return jsonError(404, 'Prüfung nicht gefunden');
  setCheckEnabled(id, body.data.enabled);
  void recheckShopCheck().catch(() => {});
  return Response.json({ ok: true });
}

// Only custom checks can be deleted
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id.startsWith(CUSTOM_PREFIX) || !listCustom().some(c => c.id === id)) return jsonError(404, 'Eigene Prüfung nicht gefunden');
  removeCustom(id);
  void recheckShopCheck().catch(() => {});
  return Response.json({ ok: true });
}

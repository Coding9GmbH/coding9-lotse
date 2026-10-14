import type { SistrixTestResult } from '@/lib/protocol';
import { errMsg } from '@/server/http';
import { testSistrix } from '@/server/features/sistrix-api';

export const dynamic = 'force-dynamic';

export async function POST() {
  let r: SistrixTestResult;
  try { r = await testSistrix(); } catch (e) { r = { ok: false, message: errMsg(e).replace(/\s+/g, ' ').slice(0, 300), credits: null }; }
  return Response.json(r);
}

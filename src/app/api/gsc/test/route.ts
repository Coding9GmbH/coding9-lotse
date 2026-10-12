import type { GscTestResult } from '@/lib/protocol';
import { errMsg } from '@/server/http';
import { testGsc } from '@/server/features/gsc-google';

export const dynamic = 'force-dynamic';

export async function POST() {
  let r: GscTestResult;
  try { r = await testGsc(); } catch (e) { r = { ok: false, message: errMsg(e).replace(/\s+/g, ' ').slice(0, 300), sites: [] }; }
  return Response.json(r);
}

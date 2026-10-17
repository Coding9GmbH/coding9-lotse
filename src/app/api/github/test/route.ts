import type { GithubTestResult } from '@/lib/protocol';
import { errMsg } from '@/server/http';
import { scrub, testGithub } from '@/server/github';

export const dynamic = 'force-dynamic';

export async function POST() {
  let r: GithubTestResult;
  try { r = await testGithub(); } catch (e) { r = { ok: false, message: scrub(errMsg(e)), login: null, repos: null, readOnly: [] }; }
  return Response.json(r);
}

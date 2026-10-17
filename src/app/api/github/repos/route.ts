import { errMsg, jsonError } from '@/server/http';
import { githubConnected, listRepos, scrub } from '@/server/github';

export const dynamic = 'force-dynamic';

/** Repositories the stored token can see (names and permissions only). */
export async function GET() {
  if (!githubConnected()) return jsonError(400, 'Noch kein GitHub-Token gespeichert (Einstellungen → Integrationen).');
  try { return Response.json({ repos: await listRepos() }); } catch (e) { return jsonError(502, scrub(errMsg(e))); }
}

import { errMsg, jsonError } from '@/server/http';
import { assertRepoName, githubConnected, listBranches, scrub } from '@/server/github';

export const dynamic = 'force-dynamic';

/** Branches of one repository (?repo=owner/name). */
export async function GET(req: Request) {
  const repo = new URL(req.url).searchParams.get('repo') ?? '';
  try { assertRepoName(repo); } catch (e) { return jsonError(400, errMsg(e)); }
  if (!githubConnected()) return jsonError(400, 'Noch kein GitHub-Token gespeichert (Einstellungen → Integrationen).');
  try { return Response.json({ branches: await listBranches(repo) }); } catch (e) { return jsonError(502, scrub(errMsg(e))); }
}

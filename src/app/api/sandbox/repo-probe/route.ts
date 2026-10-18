import { assertBaseBranch, assertRepoName } from '@/server/git';
import { githubConnected } from '@/server/github';
import { jsonError } from '@/server/http';
import { taskRoute } from '@/server/sandbox/api';
import { probeRepo } from '@/server/sandbox/probe';
import { errMsg } from '@/server/util';

export const dynamic = 'force-dynamic';

/** "Sandbox starten": what repo@branch is before the start – empty (a new plugin; the dialog asks for its technical name and suggests one
 *  from the repository name), a plugin, theme or whole project, or nothing Lotse knows (only an own setup works) – and its
 *  .lotse/sandbox.json with the commands it wants to run. detected null = GitHub and the clone could not tell (the setup decides). */
export function GET(req: Request) {
  return taskRoute(req, async () => {
    const q = new URL(req.url).searchParams, repo = q.get('repo') ?? '', branch = q.get('branch') ?? '';
    try { assertRepoName(repo); await assertBaseBranch(branch); } catch (e) { return jsonError(400, errMsg(e)); }
    if (!githubConnected()) return jsonError(400, 'GitHub ist nicht verbunden (Einstellungen → Integrationen).');
    return Response.json(await probeRepo(repo, branch));
  });
}

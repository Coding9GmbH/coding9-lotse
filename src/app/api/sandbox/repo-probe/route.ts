import { assertBaseBranch, assertRepoName } from '@/server/git';
import { githubConnected, listRootNames } from '@/server/github';
import { jsonError } from '@/server/http';
import { taskRoute } from '@/server/sandbox/api';
import { isEmptyRepoListing, pluginNameFromRepo } from '@/lib/sandbox-task';
import type { RepoProbe } from '@/lib/protocol';
import { errMsg } from '@/server/util';

export const dynamic = 'force-dynamic';

/** "Sandbox starten": is repo@branch still empty (README, LICENSE, .gitignore at most)? Then the dialog asks for the new plugin's
 *  technical name and suggests one from the repository name. empty null = GitHub could not tell (the setup decides after the clone). */
export function GET(req: Request) {
  return taskRoute(req, async () => {
    const q = new URL(req.url).searchParams, repo = q.get('repo') ?? '', branch = q.get('branch') ?? '';
    try { assertRepoName(repo); await assertBaseBranch(branch); } catch (e) { return jsonError(400, errMsg(e)); }
    if (!githubConnected()) return jsonError(400, 'GitHub ist nicht verbunden (Einstellungen → Integrationen).');
    const suggestedName = pluginNameFromRepo(repo);
    try { return Response.json({ empty: isEmptyRepoListing(await listRootNames(repo, branch)), suggestedName } satisfies RepoProbe); }
    catch { return Response.json({ empty: null, suggestedName } satisfies RepoProbe); }
  });
}

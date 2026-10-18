import { z } from 'zod';
import { auditAdd } from '@/server/db';
import { checkRepoAccess, createRepo, githubConnected, listRepoOwners, scrub, type CreateRepoError } from '@/server/github';
import { jsonError, parseJson } from '@/server/http';
import { taskRoute } from '@/server/sandbox/api';
import { messages } from '@/lib/i18n';
import { requestLocale } from '@/lib/i18n/locales';
import { errMsg } from '@/server/util';

export const dynamic = 'force-dynamic';

const NOT_CONNECTED = 'GitHub ist nicht verbunden (Einstellungen → Integrationen).';
const schema = z.object({ owner: z.string().min(1).max(39), name: z.string().min(1).max(100), description: z.string().max(300).optional() }).strict();

/** "Neues Projekt" in "Sandbox starten": the accounts the token may create a repository under (its user, its organisations). */
export function GET(req: Request) {
  return taskRoute(req, async () => {
    if (!githubConnected()) return jsonError(400, NOT_CONNECTED);
    try { return Response.json({ owners: await listRepoOwners() }); } catch (e) { return jsonError(502, scrub(errMsg(e))); }
  });
}

/** Creates a private repository for a new plugin (README on main, so it clones as an empty repository) and checks the token sees it.
 *  Refusals name what is missing (name, owner, name taken, the token permission). Audited with owner and name. */
export function POST(req: Request) {
  return taskRoute(req, async () => {
    const body = await parseJson(req, schema);
    if (!body.ok) return body.res;
    const m = messages(requestLocale(req)).server, { owner, name, description } = body.data;
    if (!githubConnected()) return jsonError(400, NOT_CONNECTED);
    let repo;
    try { repo = await createRepo({ owner, name, description }); } catch (e) {
      const code = (e as { code?: CreateRepoError }).code;
      if (code === 'name') return jsonError(400, m.repoNameInvalid);
      if (code === 'owner') return jsonError(400, m.repoOwnerUnknown);
      if (code === 'exists') return jsonError(409, m.repoExists(`${owner}/${name}`));
      if (code === 'permission') return jsonError(403, m.repoNoPermission(owner));
      return jsonError(502, m.repoCreateFailed(scrub(errMsg(e))));
    }
    auditAdd({ decision: 'changed', kind: 'github-repo', action: 'create', title: `GitHub-Projekt angelegt: ${repo.fullName}`, repo: repo.fullName, private: repo.private });
    try { repo = await checkRepoAccess(repo.fullName); } catch { return jsonError(409, m.repoNotVisible(repo.fullName)); }
    return Response.json({ repo }, { status: 201 });
  });
}

import { z } from 'zod';
import { messages } from '@/lib/i18n';
import { requestLocale } from '@/lib/i18n/locales';
import { currentActor } from '@/server/actor';
import { assertBaseBranch, assertRepoName } from '@/server/git';
import { jsonError, parseJson } from '@/server/http';
import { taskRoute } from '@/server/sandbox/api';
import { forgetProbes, probeRepo } from '@/server/sandbox/probe';
import { approveRepoFile } from '@/server/sandbox/repo-config';
import { errMsg } from '@/server/util';

export const dynamic = 'force-dynamic';

const schema = z.object({ repo: z.string().max(200), branch: z.string().max(200), hash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();

/** "Befehle erlauben" in "Sandbox starten": the commands of repo@branch's .lotse/sandbox.json the dialog showed. Only the content Lotse
 *  read itself counts – the hash must be that of the file as it is now (a changed file is shown again). Remembered per repository and
 *  file content, audited with the commands' labels. */
export function POST(req: Request) {
  return taskRoute(req, async () => {
    const body = await parseJson(req, schema);
    if (!body.ok) return body.res;
    const { repo, branch, hash } = body.data;
    try { assertRepoName(repo); await assertBaseBranch(branch); } catch (e) { return jsonError(400, errMsg(e)); }
    forgetProbes(repo);
    const now = await probeRepo(repo, branch), f = now.repoFile;
    if (!f || 'error' in f || f.hash !== hash) return jsonError(409, messages(requestLocale(req)).server.repoFileChanged);
    approveRepoFile(repo, hash, currentActor(), f.commands.map(c => c.label));
    forgetProbes(repo);
    return Response.json(await probeRepo(repo, branch));
  });
}

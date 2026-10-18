import { z } from 'zod';
import { currentActor } from '@/server/actor';
import { jsonError, parseJson } from '@/server/http';
import { auditTask, taskRoute } from '@/server/sandbox/api';
import { runSteps } from '@/server/sandbox/jobs';
import { forgetProbes } from '@/server/sandbox/probe';
import { approveRepoFile } from '@/server/sandbox/repo-config';
import { mustTask, publicTask, saveTask } from '@/server/sandbox/tasks';

export const dynamic = 'force-dynamic';

const schema = z.object({ decision: z.enum(['approve', 'skip']), hash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();

/** The setup stopped at the repository's .lotse/sandbox.json: "Befehle erlauben" (remembered for this repository and exactly this file
 *  content) or "Ohne diese Befehle" (this sandbox only); either way the setup continues at "Plugin erkennen", which reads the file again
 *  – a file changed meanwhile is asked about again. */
export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return taskRoute(req, async () => {
    const body = await parseJson(req, schema);
    if (!body.ok) return body.res;
    const t = mustTask((await params).id), { decision, hash } = body.data;
    if (t.repoFile?.state !== 'pending' || t.repoFile.hash !== hash) return jsonError(409, 'Für diese Sandbox wartet keine Entscheidung zu diesen Befehlen (mehr).');
    if (decision === 'approve') { approveRepoFile(t.repo, hash, currentActor(), t.repoFile.commands.map(c => c.label)); forgetProbes(t.repo); }
    else { t.setup = { ...(t.setup ?? { source: 'repo', mode: 'auto', commands: [], env: [] }), skipRepoHash: hash }; saveTask(t, false); }
    const next = runSteps(t.id, 'detect-layout');
    auditTask(next, 'start', { fromStep: 'detect-layout', repoFile: decision });
    return Response.json({ task: publicTask(next) }, { status: 202 });
  });
}

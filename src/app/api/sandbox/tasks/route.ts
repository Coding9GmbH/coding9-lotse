import { z } from 'zod';
import { codeTaskDelete } from '@/server/db';
import { assertBaseBranch, assertRepoName } from '@/server/git';
import { checkRepoAccess, githubConnected } from '@/server/github';
import { chatIdSchema, jsonError, parseJson } from '@/server/http';
import { auditTask, taskRoute } from '@/server/sandbox/api';
import { releaseDump } from '@/server/sandbox/dumps';
import { runSteps } from '@/server/sandbox/jobs';
import { attachedTask, createTask, listTasks, publicTask } from '@/server/sandbox/tasks';
import { noteSandboxAttached } from '@/server/sessions';
import { errMsg } from '@/server/util';

export const dynamic = 'force-dynamic';

const schema = z.object({
  chatId: chatIdSchema,
  title: z.string().trim().max(120).optional(),
  goal: z.string().max(4000).default(''),
  repo: z.string().max(200),
  baseBranch: z.string().max(200),
  dumpId: z.string().max(40).optional(),
}).strict();

/** Task list (without step logs). */
export function GET(req: Request) {
  return taskRoute(req, async () => Response.json({ tasks: listTasks().map(t => publicTask(t, { logs: false })) }));
}

/** Attach a sandbox to a chat: repository access is checked first; the setup starts in the background. One sandbox per chat. */
export function POST(req: Request) {
  return taskRoute(req, async () => {
    const body = await parseJson(req, schema);
    if (!body.ok) return body.res;
    const { chatId, title, goal, repo, baseBranch, dumpId } = body.data;
    if (attachedTask(chatId)) return jsonError(409, 'An diesem Chat hängt schon eine Sandbox. Erst „Aufgabe abschließen“, dann eine neue starten.');
    if (!githubConnected()) return jsonError(400, 'GitHub ist nicht verbunden (Einstellungen → Integrationen).');
    try { assertRepoName(repo); await assertBaseBranch(baseBranch); await checkRepoAccess(repo); } catch (e) { return jsonError(400, errMsg(e)); }
    let created;
    try { created = createTask({ chatId, title, goal, repo, baseBranch, dumpId }); } catch (e) { return jsonError((e as { status?: number }).status ?? 400, errMsg(e)); }
    let t;
    try { t = runSteps(created.id); } catch (e) { codeTaskDelete(created.id); if (dumpId) releaseDump(dumpId); throw e; }
    auditTask(t, 'create', { baseBranch, chatId, ...(t.dump ? { dump: t.dump.name } : {}) });
    noteSandboxAttached(chatId, t);
    return Response.json({ task: publicTask(t) }, { status: 201 });
  });
}

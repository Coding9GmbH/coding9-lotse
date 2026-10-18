import { z } from 'zod';
import { codeTaskDelete } from '@/server/db';
import { assertBaseBranch, assertRepoName } from '@/server/git';
import { checkRepoAccess, githubConnected } from '@/server/github';
import { chatIdSchema, jsonError, parseJson } from '@/server/http';
import { auditTask, taskRoute } from '@/server/sandbox/api';
import { releaseDump } from '@/server/sandbox/dumps';
import { runSteps } from '@/server/sandbox/jobs';
import { attachedMsg, attachedTask, pluginNameMsg, createTask, listTasks, publicTask } from '@/server/sandbox/tasks';
import { requestLocale } from '@/lib/i18n/locales';
import { PLUGIN_NAME } from '@/lib/sandbox-task';
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
  /** technical name of a new plugin, used if the repository turns out empty (and for a sandbox without a project) */
  pluginName: z.string().max(200).optional(),
  /** A20: "Ohne Projekt starten" (repo and baseBranch are ignored), the mode, an own setup's target, own commands and variables of this
   *  sandbox (the user's input in the dialog), the repository file's commands the user declined */
  source: z.enum(['repo', 'none']).default('repo'),
  mode: z.enum(['auto', 'plugin', 'project', 'custom']).default('auto'),
  targetPath: z.string().max(300).optional(),
  commands: z.array(z.object({ label: z.string().max(200), command: z.string().max(5000), phase: z.enum(['after-db', 'final']), timeoutSec: z.number().optional() })).max(10).optional(),
  env: z.array(z.object({ key: z.string().max(100), value: z.string().max(5000) })).max(20).optional(),
  skipRepoHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
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
    const { chatId, title, goal, repo, baseBranch, dumpId, pluginName, source, mode, targetPath, commands, env, skipRepoHash } = body.data, locale = requestLocale(req);
    if (pluginName && !PLUGIN_NAME.test(pluginName)) return jsonError(400, pluginNameMsg(locale));
    if (attachedTask(chatId)) return jsonError(409, attachedMsg(locale));
    if (source === 'repo') {
      if (!githubConnected()) return jsonError(400, 'GitHub ist nicht verbunden (Einstellungen → Integrationen).');
      try { assertRepoName(repo); await assertBaseBranch(baseBranch); await checkRepoAccess(repo); } catch (e) { return jsonError(400, errMsg(e)); }
    }
    let created;
    try { created = createTask({ chatId, title, goal, repo, baseBranch, dumpId, pluginName: pluginName || undefined, source, mode, targetPath, commands, env, skipRepoHash }, locale); } catch (e) { return jsonError((e as { status?: number }).status ?? 400, errMsg(e)); }
    let t;
    try { t = runSteps(created.id); } catch (e) { codeTaskDelete(created.id); if (dumpId) releaseDump(dumpId); throw e; }
    auditTask(t, 'create', { baseBranch: t.baseBranch, chatId, ...(t.dump ? { dump: t.dump.name } : {}), ...(t.pluginName ? { pluginName: t.pluginName } : {}),
      ...(source === 'none' ? { source } : {}), ...(mode !== 'auto' ? { mode } : {}), ...(t.setup?.targetPath ? { targetPath: t.setup.targetPath } : {}),
      ...(t.setup?.commands.length ? { commands: t.setup.commands.map(c => c.label) } : {}), ...(t.setup?.env.length ? { env: t.setup.env.map(v => v.key) } : {}) });
    noteSandboxAttached(chatId, t);
    return Response.json({ task: publicTask(t) }, { status: 201 });
  });
}

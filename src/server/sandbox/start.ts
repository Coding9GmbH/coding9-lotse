import 'server-only';
// "Sandbox starten" (A20, A22): the request as the start dialog sends it and the start itself – shared by POST /api/sandbox/tasks and
// the quick starts (a quick start is a saved request of the dialog, quick-starts.ts), so both follow the same checks.
import { z } from 'zod';
import type { Locale } from '@/lib/i18n';
import { codeTaskDelete } from '../db';
import { assertBaseBranch, assertRepoName } from '../git';
import { checkRepoAccess, githubConnected } from '../github';
import { chatIdSchema } from '../http';
import { noteSandboxAttached } from '../sessions';
import { errMsg } from '../util';
import { auditTask } from './api';
import { releaseDump } from './dumps';
import { runSteps } from './jobs';
import { attachedMsg, attachedTask, checkSetup, createTask, type CodeTask } from './tasks';

/** What the dialog chose, without the chat: the part a quick start keeps (plus its kind, quick-starts.ts) */
export const setupFields = {
  title: z.string().trim().max(120).optional(),
  repo: z.string().max(200),
  baseBranch: z.string().max(200),
  dumpId: z.string().max(40).optional(),
  /** technical name of a new plugin, used if the repository turns out empty (and for a sandbox without a project) */
  pluginName: z.string().max(200).optional(),
  /** A20: "Ohne Projekt starten" (repo and baseBranch are ignored), the mode, an own setup's target, own commands and variables of this
   *  sandbox (the user's input in the dialog) */
  source: z.enum(['repo', 'none']).default('repo'),
  mode: z.enum(['auto', 'plugin', 'project', 'custom']).default('auto'),
  targetPath: z.string().max(300).optional(),
  commands: z.array(z.object({ label: z.string().max(200), command: z.string().max(5000), phase: z.enum(['after-db', 'final']), timeoutSec: z.number().optional() })).max(10).optional(),
  env: z.array(z.object({ key: z.string().max(100), value: z.string().max(5000) })).max(20).optional(),
  /** A22: another image tag, the preview's first page, notes for the AI of this sandbox */
  image: z.string().max(120).optional(),
  previewPath: z.string().max(300).optional(),
  notes: z.string().max(8000).optional(),
};
export const startSchema = z.object({
  chatId: chatIdSchema,
  goal: z.string().max(4000).default(''),
  ...setupFields,
  /** the repository file's commands the user declined in the dialog */
  skipRepoHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict();
export type StartInput = z.infer<typeof startSchema>;

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

/** Attaches a sandbox to a chat and starts its setup in the background: repository access is checked first, one sandbox per chat.
 *  Throws errors with a status (400 input, 409 already attached). `audit`: extra fields of the "create" entry (e.g. the quick start). */
export async function startSandbox(input: StartInput, locale: Locale, audit: Record<string, unknown> = {}): Promise<CodeTask> {
  const { chatId, source, mode, dumpId } = input;
  checkSetup(input, locale); // the dialog's input first (again in createTask): no GitHub call for a request that cannot start
  if (attachedTask(chatId)) throw fail(409, attachedMsg(locale));
  if (source === 'repo') {
    if (!githubConnected()) throw fail(400, 'GitHub ist nicht verbunden (Einstellungen → Integrationen).');
    try { assertRepoName(input.repo); await assertBaseBranch(input.baseBranch); await checkRepoAccess(input.repo); } catch (e) { throw fail(400, errMsg(e)); }
  }
  const created = createTask({ ...input, pluginName: input.pluginName || undefined }, locale);
  let t;
  try { t = runSteps(created.id); } catch (e) { codeTaskDelete(created.id); if (dumpId) releaseDump(dumpId); throw e; }
  const s = t.setup;
  auditTask(t, 'create', { baseBranch: t.baseBranch, chatId, ...(t.dump ? { dump: t.dump.name } : {}), ...(t.pluginName ? { pluginName: t.pluginName } : {}),
    ...(source === 'none' ? { source } : {}), ...(mode !== 'auto' ? { mode } : {}), ...(s?.targetPath ? { targetPath: s.targetPath } : {}),
    ...(s?.commands.length ? { commands: s.commands.map(c => c.label) } : {}), ...(s?.env.length ? { env: s.env.map(v => v.key) } : {}),
    ...(s?.image ? { image: s.image } : {}), ...(s?.previewPath ? { previewPath: s.previewPath } : {}), ...(s?.notes ? { notes: true } : {}), ...audit });
  noteSandboxAttached(chatId, t);
  return t;
}

import 'server-only';
// Shared frame of the task routes: 403 while Sandbox Coding is off, startup reconcile, actor for the audit, errors with status.
import { actorFromRequest, withActor } from '../actor';
import { auditAdd } from '../db';
import { jsonError } from '../http';
import { errMsg } from '../util';
import { sandboxForbidden } from './env';
import { ensureReconciled } from './reconcile';
import type { CodeTask } from './tasks';

export async function taskRoute(req: Request, fn: () => Promise<Response>): Promise<Response> {
  const off = sandboxForbidden();
  if (off) return off;
  await ensureReconciled();
  try { return await withActor(actorFromRequest(req), fn); } catch (e) {
    const status = (e as { status?: unknown }).status;
    return jsonError(typeof status === 'number' && status >= 400 && status < 600 ? status : 500, errMsg(e));
  }
}

export type TaskAction = 'create' | 'start' | 'stop' | 'pause' | 'resume' | 'finish' | 'delete' | 'replace-db' | 'screenshot';
/** Audit: names and ids only. */
export const auditTask = (t: Pick<CodeTask, 'id' | 'title' | 'repo' | 'branch'>, action: TaskAction, extra: Record<string, unknown> = {}) =>
  auditAdd({ decision: 'changed', kind: 'sandbox-task', taskId: t.id, action, title: `Sandbox-Aufgabe: ${t.title}`, repo: t.repo, branch: t.branch, ...extra });

import 'server-only';
// Internet for a task container, only after a human allowed it: the card of request_internet in the chat (the AI asks, the click
// decides) or the switch in the status line of the right panel. Allowing attaches the running container to the second network
// lotse-sandbox-egress (not internal, created on demand); revoking detaches it. Pause, stop, finish, a new setup and Sandbox Coding
// switched off revoke as well, and a woken container always starts offline. The environment setting "Internet im Container" can
// forbid it altogether ('never'). Lotse stays out of reach on both networks: requests from their subnets are refused (proxy.ts).
// Docker's state is what counts: revoking always detaches, whatever the stored flag says.
import type { CodeTask } from './tasks';
import { egressSubnet } from '../access';
import { auditAdd } from '../db';
import { log } from '../log';
import { singleton } from '../state';
import { sandboxPublic, sandboxStatus } from './env';
import { EGRESS_NET } from './labels';
import { ensureEgressNetwork, networkMode } from './network';
import { getRunner } from './runner';
import { getTask, listTasks, mustTask, now, saveTask } from './tasks';

export type InternetVia = 'chat' | 'panel';
/** Why access ended: the user (panel/chat), the lifecycle (pause also covers idle, capacity and switching off), the policy, a restart. */
export type RevokeReason = 'panel' | 'pause' | 'finish' | 'setup' | 'wake' | 'policy' | 'restart';

export const INTERNET_NEVER = 'Internet im Container ist in der Umgebung ausgeschaltet („nie“).';
const OPEN_EGRESS = 'Internet bleibt gesperrt: Ohne LOTSE_SANDBOX_EGRESS_SUBNET könnte Lotse Anfragen aus dem Internet-Netz der Sandbox nicht erkennen. Aktuelle docker-compose.sandbox.yml verwenden (make sandbox-up) oder LOTSE_PASSWORD setzen.';
const NOT_READY = 'Internet gibt es nur für eine bereite Sandbox mit laufendem Container.';

const err = (message: string, status: number) => Object.assign(new Error(message), { status });

/** Why internet cannot be allowed right now (null = it can, after a human's click). Lotse in Docker without a password needs the
 *  pinned egress subnet, like LOTSE_SANDBOX_SUBNET for the internal network. */
export function internetBlocked(env: Record<string, string | undefined> = process.env): string | null {
  if (sandboxPublic(env).internet === 'never') return INTERNET_NEVER;
  if (!env.LOTSE_PASSWORD && networkMode(env) === 'network' && !egressSubnet(env)) return OPEN_EGRESS;
  return null;
}

/** One change of a task's internet access at a time (own chain: a long sandbox_bash under the task lock must not hold up "sperren"). */
function serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const L = singleton<Map<string, Promise<unknown>>>('sandboxInternetLocks', () => new Map());
  const next = (L.get(id) ?? Promise.resolve()).catch(() => {}).then(fn);
  const tail = next.catch(() => {});
  L.set(id, tail);
  void tail.then(() => { if (L.get(id) === tail) L.delete(id); });
  return next;
}

const audit = (t: CodeTask, action: 'internet-on' | 'internet-off' | 'internet-denied' | 'internet-failed', extra: Record<string, unknown>) =>
  auditAdd({ decision: 'changed', kind: 'sandbox-task', taskId: t.id, action, title: `Sandbox-Aufgabe: ${t.title}`, repo: t.repo, branch: t.branch, ...(t.chatId ? { chatId: t.chatId } : {}), ...extra });

/** A human allowed internet for this task (the click on the card or the switch): attach the running container to lotse-sandbox-egress. */
export function grantInternet(id: string, o: { via: InternetVia; reason?: string }): Promise<CodeTask> {
  const s = sandboxStatus();
  if (!s.enabled) return Promise.reject(err(s.message ?? 'Sandbox Coding ist ausgeschaltet.', 403));
  const blocked = internetBlocked();
  if (blocked) return Promise.reject(err(blocked, 403));
  return serial(id, async () => {
    const t = mustTask(id);
    if (t.status !== 'ready' || !t.containerId || !t.containerRunning) throw err(NOT_READY, 409);
    if (t.internet) return t;
    const r = getRunner(), container = t.containerId;
    await ensureEgressNetwork(r);
    await r.connectEgress(container);
    const fresh = mustTask(id), nowBlocked = internetBlocked();
    // paused, finished or the policy switched to "nie" meanwhile (revokeAllInternet did not see this grant yet): detach again
    if (nowBlocked || fresh.status !== 'ready' || fresh.containerId !== container) {
      await r.disconnectEgress(container).catch(e => log.warn('Internetzugang nicht gesperrt', { task: id, error: e }));
      throw nowBlocked ? err(nowBlocked, 403) : err(NOT_READY, 409);
    }
    fresh.internet = { since: now(), via: o.via };
    saveTask(fresh);
    audit(fresh, 'internet-on', { via: o.via, ...(o.reason ? { reason: o.reason.slice(0, 300) } : {}) });
    return fresh;
  });
}

/** The user declined the AI's request, or it was still open at a restart (audit only: nothing was attached). */
export function noteInternetDenied(id: string, reason: string, cause?: 'restart') {
  const t = getTask(id);
  if (t) audit(t, 'internet-denied', { via: 'chat', reason: reason.slice(0, 300), ...(cause ? { cause } : {}) });
}

/** The user allowed the AI's request, but attaching failed (paused meanwhile, policy "nie", Docker): audited, nothing is open. */
export function noteInternetFailed(id: string, reason: string, error: string) {
  const t = getTask(id);
  if (t) audit(t, 'internet-failed', { via: 'chat', reason: reason.slice(0, 300), error: error.slice(0, 300) });
}

/** Detach the task's container from lotse-sandbox-egress (if Docker says it is attached) and clear the flag; audited when access was on.
 *  Throws when Docker cannot detach it (callers that stop the container anyway only log that). */
export function revokeInternet(id: string, reason: RevokeReason): Promise<CodeTask | null> {
  return serial(id, async () => {
    const t = getTask(id);
    if (!t) return null;
    if (t.containerId) await getRunner().disconnectEgress(t.containerId);
    const fresh = getTask(id);
    if (!fresh?.internet) return fresh;
    const since = fresh.internet.since;
    fresh.internet = null;
    saveTask(fresh);
    audit(fresh, 'internet-off', { reason, since });
    return fresh;
  });
}

/** Policy switched to "nie": every task goes offline. Returns the tasks that had access. */
export async function revokeAllInternet(reason: RevokeReason): Promise<string[]> {
  const ids = listTasks().filter(t => t.internet && t.status !== 'done').map(t => t.id);
  for (const id of ids) await revokeInternet(id, reason).catch(e => log.warn('Internetzugang nicht gesperrt', { task: id, error: e }));
  return ids;
}

/** After a restart: the flag follows Docker; an attachment nobody allowed (or of a stopped container) is removed. */
export async function reconcileInternet(t: CodeTask, info: { running: boolean; networks: string[] }): Promise<void> {
  const attached = info.networks.includes(EGRESS_NET);
  if (attached && t.internet && info.running) return;
  if (attached) await revokeInternet(t.id, 'restart');
  else if (t.internet) { const fresh = getTask(t.id); if (fresh) { fresh.internet = null; saveTask(fresh, false); } t.internet = null; }
}

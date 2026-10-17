import { bindAddress, extraAllowedHosts, loopbackBind, openWithoutPassword } from '@/server/access';

/** The fields the startup warning reads. A partial object is enough, so the test need not build a full ProcessEnv. */
export type BindEnv = {
  AICB_DOCKER?: string;
  LOTSE_BIND?: string;
  HOSTNAME?: string;
  HOST?: string;
  LOTSE_PASSWORD?: string;
  ALLOWED_HOSTS?: string;
  [key: string]: string | undefined;
};

/** Warning, not a startup abort: outside Docker on an open bind without password, in the container if LOTSE_BIND is missing or not loopback. */
export function bindWarning(env: BindEnv): string | null {
  if (env.AICB_DOCKER === '1') {
    const bind = bindAddress(env);
    if (loopbackBind(env)) return null;
    const shown = bind === '' ? 'nicht gesetzt' : bind;
    return `WARNUNG: LOTSE_BIND ist ${shown}, nicht Loopback – der Container sieht nicht, worauf der Port veröffentlicht ist. Setze LOTSE_BIND auf 127.0.0.1, localhost oder ::1.`;
  }
  const host = bindAddress(env);
  if (!loopbackBind(env) && !env.LOTSE_PASSWORD)
    return `WARNUNG: Lotse lauscht auf ${host} ohne LOTSE_PASSWORD – jeder im Netzwerk könnte Änderungen am Shop freigeben.`;
  return null;
}

/** ALLOWED_HOSTS opens Lotse to other host names; without LOTSE_PASSWORD anyone who can reach the name can approve changes.
 *  Only a warning (also shown in the settings), not a startup abort: existing installs behind a proxy with its own login keep running. */
export function allowedHostsWarning(env: BindEnv): string | null {
  if (!openWithoutPassword(env)) return null;
  return `WARNUNG: ALLOWED_HOSTS (${extraAllowedHosts(env.ALLOWED_HOSTS).join(', ')}) ist gesetzt, LOTSE_PASSWORD nicht – jeder, der Lotse unter diesem Namen erreicht, kann Änderungen am Shop freigeben. Setze LOTSE_PASSWORD.`;
}

// Once at server start
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // Real socket address for the host check in proxy.ts (the client can set X-Forwarded-For itself), before the first request
  const [{ installPeerStamp }, http, https] = await Promise.all([import('@/server/access'), import('node:http'), import('node:https')]);
  installPeerStamp(http.Server.prototype, https.Server.prototype);
  for (const warning of [bindWarning(process.env), allowedHostsWarning(process.env)]) if (warning) console.warn(warning);
  console.log(`Lotse ${process.env.LOTSE_VERSION || 'dev'} bereit${process.env.LOTSE_PASSWORD ? ' (Login aktiv)' : ''}`);
  void sandboxDockerWarning();
}

/** Sandbox Coding switched on, but Docker unreachable: say so at startup (in the background, never blocks the start). */
async function sandboxDockerWarning() {
  try {
    const { sandboxStatus, dockerState } = await import('@/server/sandbox/env');
    if (!sandboxStatus().enabled) return;
    const { ensureReconciled } = await import('@/server/sandbox/reconcile');
    void ensureReconciled(); // interrupted steps, orphaned containers, idle sweeper
    const d = await dockerState(true);
    if (!d.reachable) console.warn(`WARNUNG: Sandbox Coding ist eingeschaltet, aber: ${d.error ?? 'Docker ist nicht erreichbar.'} Anleitung: docs/self-hosting.md → „Sandbox Coding aktivieren“.`);
  } catch { /* the settings page shows the state as well */ }
}

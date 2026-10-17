import { z } from 'zod';
import type { SandboxEnvView } from '@/lib/protocol';
import { auditAdd } from '@/server/db';
import { errMsg, jsonError, parseJson } from '@/server/http';
import { dockerState, forgetDockerState, sandboxPublic, saveSandbox, stopRunningSandboxes } from '@/server/sandbox/env';
import { revokeAllInternet } from '@/server/sandbox/internet';
import { suspendAll } from '@/server/sandbox/jobs';
import { ensureReconciled } from '@/server/sandbox/reconcile';
import { getRunner } from '@/server/sandbox/runner';
import { TEMPLATES, describeTemplate } from '@/server/sandbox/templates';

export const dynamic = 'force-dynamic';

// Sandbox environment: readable and switchable even while off (that is where it is switched on).
// Docker is only contacted while Sandbox Coding is on. Secret variable values only go in, never out.
const schema = z.object({
  enabled: z.boolean().optional(),
  image: z.string().max(200).optional(),
  memoryMb: z.number().optional(),
  cpus: z.number().optional(),
  idleMinutes: z.number().optional(),
  defaultRepo: z.string().max(200).optional(),
  defaultBranch: z.string().max(200).optional(),
  internet: z.enum(['approval', 'never']).optional(),
  envVars: z.array(z.object({ key: z.string().max(100), secret: z.boolean(), value: z.string().max(10_000).optional() })).max(100).optional(),
  commands: z.array(z.object({ id: z.string().max(40).optional(), label: z.string().max(200), command: z.string().max(5000), phase: z.enum(['after-db', 'final']), timeoutSec: z.number().optional() })).max(50).optional(),
  screenshotPaths: z.array(z.string().max(300)).max(20).optional(),
}).strict();

async function view(): Promise<SandboxEnvView> {
  const env = sandboxPublic();
  const docker = env.status.enabled ? await dockerState() : null;
  const imagePresent = docker?.reachable ? await getRunner().imagePresent(env.image).catch(() => null) : null;
  return { env, docker, imagePresent, templates: Object.values(TEMPLATES).map(describeTemplate) };
}

export async function GET() {
  return Response.json(await view());
}

export async function PUT(req: Request) {
  const body = await parseJson(req, schema);
  if (!body.ok) return body.res;
  const wasOn = sandboxPublic().status.enabled;
  let changed: string[];
  try { ({ changed } = saveSandbox(body.data)); } catch (e) { return jsonError(400, errMsg(e)); }
  if (changed.length) auditAdd({ decision: 'changed', kind: 'settings', title: 'Sandbox-Umgebung geändert', fields: Object.fromEntries(changed.map(k => [k, 'geändert'])) }); // names only, never values
  const nowOn = sandboxPublic().status.enabled;
  if (nowOn !== wasOn) forgetDockerState();
  // Switched off: running task containers are stopped, not removed (switching on again resumes them)
  if (wasOn && !nowOn) { await suspendAll().catch(() => 0); await stopRunningSandboxes().catch(() => 0); }
  if (!wasOn && nowOn) void ensureReconciled();
  // "Internet im Container: nie": every task goes offline at once
  if (changed.includes('internet') && sandboxPublic().internet === 'never') await revokeAllInternet('policy').catch(() => []);
  return Response.json(await view());
}

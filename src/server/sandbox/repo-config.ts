import 'server-only';
// .lotse/sandbox.json (A20): a repository may say how its sandbox is set up, like a devcontainer file. Repository content is untrusted:
// - the file is validated with a schema; unknown keys are ignored (and named), anything invalid stops with a clear message
// - its setup commands run only after a human approved exactly this content (repository + SHA-256 of the file, remembered here);
//   a changed file needs a new approval; they still run only inside the task container, like the environment's own commands
// - environment variables are named only: values come from the Lotse environment, never from the repository
// - the image may only be another tag of the configured image repository that the template allows
// - agent notes are data in the prompt (fenced), never instructions
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { RepoFileInfo } from '@/lib/protocol';
import { PREVIEW_PATH, targetPathProblem } from '@/lib/sandbox-task';
import { auditAdd, kvGet, kvSet } from '../db';
import { ENV_KEY, LIMITS, imageTag } from './env';
import type { SandboxTemplate } from './templates/types';

export const REPO_FILE = '.lotse/sandbox.json';
const FILE_MAX = 64 * 1024;
const KNOWN = ['$schema', 'mode', 'targetPath', 'commands', 'env', 'image', 'previewPath', 'notes'] as const;

const command = z.object({
  label: z.string().trim().min(1).max(LIMITS.label),
  command: z.string().trim().min(1).max(LIMITS.command).refine(c => !c.includes('\0'), 'enthält ein NUL-Zeichen'),
  phase: z.enum(['after-db', 'final']).default('final'),
  timeoutSec: z.number().int().min(LIMITS.timeoutSec.min).max(LIMITS.timeoutSec.max).default(LIMITS.timeoutSec.def),
});
const schema = z.object({
  mode: z.enum(['plugin', 'project', 'custom']).optional(),
  targetPath: z.string().max(200).refine(p => !targetPathProblem(p), 'muss ein absoluter Ordner unter /var/www, /opt oder /srv sein (z. B. /opt/app)').optional(),
  commands: z.array(command).max(LIMITS.commands).default([]),
  env: z.array(z.string().regex(ENV_KEY, 'nur GROSSBUCHSTABEN, Ziffern und _')).max(LIMITS.envVars).default([]),
  image: z.string().max(100).regex(/^[A-Za-z0-9._/:-]+$/, 'ungültige Zeichen').optional(),
  previewPath: z.string().regex(PREVIEW_PATH, 'muss ein Pfad des Shops sein, der mit / beginnt').optional(),
  notes: z.string().max(4000).optional(),
});

export class RepoFileError extends Error {}
const issueText = (e: z.ZodError) => e.issues.slice(0, 3).map(i => `${i.path.join('.') || '(Datei)'}: ${i.message}`).join('; ');

/** Parses the file's bytes (pure). Throws RepoFileError with a German message naming the field. */
export function parseRepoFile(raw: Buffer): RepoFileInfo {
  if (raw.length > FILE_MAX) throw new RepoFileError(`${REPO_FILE} ist zu groß (höchstens ${FILE_MAX / 1024} KB).`);
  let data: unknown;
  try { data = JSON.parse(raw.toString('utf8')); } catch { throw new RepoFileError(`${REPO_FILE} ist kein gültiges JSON.`); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new RepoFileError(`${REPO_FILE} muss ein JSON-Objekt sein.`);
  const r = schema.safeParse(data);
  if (!r.success) throw new RepoFileError(`${REPO_FILE} ist ungültig – ${issueText(r.error)}.`);
  const v = r.data;
  if (v.targetPath && v.mode && v.mode !== 'custom') throw new RepoFileError(`${REPO_FILE}: „targetPath“ gilt nur mit "mode": "custom".`);
  const ignored = Object.keys(data).filter(k => !(KNOWN as readonly string[]).includes(k)).map(k => k.slice(0, 60)).slice(0, 20);
  return {
    hash: createHash('sha256').update(raw).digest('hex'), ...(v.mode ? { mode: v.mode } : {}), ...(v.targetPath ? { targetPath: v.targetPath } : {}),
    ...(v.image ? { image: v.image } : {}), ...(v.previewPath ? { previewPath: v.previewPath } : {}), ...(v.notes?.trim() ? { notes: v.notes.trim() } : {}),
    commands: v.commands.map(c => ({ label: c.label, command: c.command, phase: c.phase, timeoutSec: c.timeoutSec })), env: [...new Set(v.env)], ignored,
  };
}

/** The file in a worktree: null = none. Never follows a symlink (.lotse or the file itself) out of the repository. */
export function readRepoFile(worktree: string): RepoFileInfo | null {
  const dir = path.join(worktree, '.lotse'), file = path.join(dir, 'sandbox.json');
  let st: fs.Stats;
  try { st = fs.lstatSync(file); } catch { return null; }
  if (fs.lstatSync(dir).isSymbolicLink() || !st.isFile()) throw new RepoFileError(`${REPO_FILE} ist keine normale Datei.`);
  if (st.size > FILE_MAX) throw new RepoFileError(`${REPO_FILE} ist zu groß (höchstens ${FILE_MAX / 1024} KB).`);
  return parseRepoFile(fs.readFileSync(file));
}

/** The image the file asks for: a tag ("6.7.14.0") or the full name; only the configured image repository, as the template allows it. */
export function repoFileImage(wanted: string, configured: string, t: SandboxTemplate): string {
  try { return imageTag(wanted, configured, t); } catch (e) { throw new RepoFileError(`${REPO_FILE}: ${(e as Error).message}`); }
}

// ---- Approvals: per repository, the hashes whose commands a human allowed ----
const KV = 'sandbox-repo-approvals';
interface Approval { hash: string; at: string; by: string | null }
const PER_REPO = 20;
const all = () => kvGet<Record<string, Approval[]>>(KV) ?? {};
const HASH = /^[0-9a-f]{64}$/;

export const repoFileApproved = (repo: string, hash: string) => !!repo && (all()[repo.toLowerCase()] ?? []).some(a => a.hash === hash);
/** "Befehle erlauben": remembered for this repository and exactly this file content; audited with the commands' labels. */
export function approveRepoFile(repo: string, hash: string, actor: string | null, labels: string[] = []): void {
  if (!repo || !HASH.test(hash)) throw new Error('Ungültige Freigabe.');
  const a = all(), key = repo.toLowerCase();
  if ((a[key] ?? []).some(x => x.hash === hash)) return;
  a[key] = [{ hash, at: new Date().toISOString(), by: actor }, ...(a[key] ?? [])].slice(0, PER_REPO);
  kvSet(KV, a);
  auditAdd({ decision: 'approved', kind: 'sandbox-repo-file', action: 'approve', title: `Einrichtungsbefehle aus ${REPO_FILE} erlaubt: ${repo}`, repo, hash: hash.slice(0, 12), commands: labels.slice(0, 20) }, actor);
}

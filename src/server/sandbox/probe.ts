import 'server-only';
// "Sandbox starten" looks at repo@branch before anything starts (A20): an (almost) empty repository becomes a new plugin; otherwise a
// shallow clone into a temporary folder shows what the setup would detect (plugin, theme, whole project or nothing known) and whether
// the repository brings a .lotse/sandbox.json (its commands, and whether they are approved already). The clone is removed at once;
// nothing runs, nothing is installed. Answers are kept for a minute (the dialog asks again on every change of the selection).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { RepoDetected, RepoProbe } from '@/lib/protocol';
import { isEmptyRepoListing, pluginNameFromRepo } from '@/lib/sandbox-task';
import { dataDir } from '../db';
import { cloneRepo } from '../git';
import { listRootNames } from '../github';
import { singleton } from '../state';
import { errMsg } from '../util';
import { sandboxPublic } from './env';
import { RepoFileError, readRepoFile, repoFileApproved } from './repo-config';
import { DEFAULT_TEMPLATE, getTemplate } from './templates';

const TTL = 60_000;
const CLONE_LIMIT = 90_000;
const cache = () => singleton<Map<string, { at: number; value: Promise<RepoProbe> }>>('sandboxRepoProbe', () => new Map());
/** Forget the cached answers (an approval changed what the probe says) */
export const forgetProbes = (repo?: string) => { for (const k of [...cache().keys()]) if (!repo || k.startsWith(`${repo.toLowerCase()}@`)) cache().delete(k); };

/** What the clone says: the template's own detection (the same the setup runs) and the repository file */
function inspect(worktree: string, repo: string): Pick<RepoProbe, 'detected' | 'repoFile'> {
  let detected: RepoDetected;
  let projectDir = '';
  try { projectDir = readRepoFile(worktree)?.projectDir ?? ''; } catch { /* reported below */ }
  try {
    const l = getTemplate(DEFAULT_TEMPLATE).detectLayout(worktree, { repo, projectDir });
    detected = l.isNew ? { kind: 'new', name: l.name } : l.kind === 'project' ? { kind: 'project', name: l.name, plugins: l.project?.plugins.length ?? 0, ...(l.root ? { root: l.root } : {}) } : { kind: l.kind === 'theme' ? 'theme' : 'plugin', name: l.name };
  } catch (e) { detected = { kind: 'unknown', reason: errMsg(e).slice(0, 300) }; }
  let repoFile: RepoProbe['repoFile'] = null;
  try {
    const f = readRepoFile(worktree);
    if (f) {
      const known = new Set(sandboxPublic().envVars.map(v => v.key));
      repoFile = { ...f, approved: !f.commands.length || repoFileApproved(repo, f.hash), missingEnv: f.env.filter(n => !known.has(n)) };
    }
  } catch (e) { repoFile = { error: e instanceof RepoFileError ? e.message : errMsg(e).slice(0, 300) }; }
  return { detected, repoFile };
}

async function probe(repo: string, branch: string): Promise<RepoProbe> {
  const suggestedName = pluginNameFromRepo(repo);
  let empty: boolean | null = null;
  try { empty = isEmptyRepoListing(await listRootNames(repo, branch)); } catch { /* GitHub could not tell: the clone may */ }
  if (empty) return { empty, suggestedName, detected: { kind: 'new', name: suggestedName }, repoFile: null };
  const dir = path.join(dataDir(), 'probe', crypto.randomBytes(8).toString('hex'));
  try {
    await cloneRepo(repo, branch, path.join(dir, 'repo'), path.join(dir, 'git'), { signal: AbortSignal.timeout(CLONE_LIMIT) });
    const r = inspect(path.join(dir, 'repo'), repo);
    return { empty: r.detected?.kind === 'new', suggestedName, ...r };
  } catch { return { empty, suggestedName, detected: null, repoFile: null }; }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** repo@branch as "Sandbox starten" shows it before the start (cached for a minute) */
export function probeRepo(repo: string, branch: string): Promise<RepoProbe> {
  const key = `${repo.toLowerCase()}@${branch}`, c = cache(), hit = c.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const value = probe(repo, branch);
  c.set(key, { at: Date.now(), value });
  value.catch(() => c.delete(key));
  return value;
}

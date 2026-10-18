import 'server-only';
// Changes of a task's workspace against its base branch: for the agent (git_diff) and the "Änderungen" tab.
// Secret and denied paths never appear, the patch is redacted and capped.
import type { TaskDiff } from '@/lib/protocol';
import { changedSince, diffAgainstBase } from '../git';
import { redact } from '../settings';
import { taskPaths, type CodeTask } from './tasks';
import { isDenied } from './workspace-fs';

const STATUS: Record<string, TaskDiff['files'][number]['status']> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed' };

/** Parses git's numstat/name-status/patch output (paths are not quoted: core.quotePath=false). */
export function parseDiff(raw: { numstat: string; status: string; patch: string }, maxBytes: number): TaskDiff {
  const counts = new Map<string, { added: number; removed: number }>();
  for (const line of raw.numstat.split('\n').filter(Boolean)) {
    const [a, r, ...p] = line.split('\t');
    const joined = p.join('\t');
    const file = joined.includes('{') ? joined.replace(/\{[^}]* => ([^}]*)\}/, '$1').replace(/\/\//g, '/') : joined.replace(/^.* => /, '');
    counts.set(file, { added: Number(a) || 0, removed: Number(r) || 0 });
  }
  const files: TaskDiff['files'] = [];
  for (const line of raw.status.split('\n').filter(Boolean)) {
    const [code, ...p] = line.split('\t');
    const file = p.at(-1) ?? '';
    if (!file || isDenied(file)) continue;
    files.push({ path: file, status: STATUS[code[0]] ?? 'modified', ...(counts.get(file) ?? { added: 0, removed: 0 }) });
  }
  const chunks = raw.patch.split(/^(?=diff --git )/m).filter(c => {
    const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(c);
    return m ? !isDenied(m[1]) && !isDenied(m[2]) : false;
  });
  let diff = redact(chunks.join(''));
  const truncated = Buffer.byteLength(diff) > maxBytes;
  if (truncated) diff = `${Buffer.from(diff).subarray(0, maxBytes).toString('utf8').replace(/�$/, '')}\n…`;
  return { files, diff, truncated };
}

export async function taskDiff(t: Pick<CodeTask, 'id' | 'baseBranch' | 'pushedSha'>, maxBytes: number, o: { sincePush?: boolean } = {}): Promise<TaskDiff> {
  const p = taskPaths(t.id);
  const d = parseDiff(await diffAgainstBase(p.worktree, p.gitDir, t.baseBranch), maxBytes);
  // published before: is there anything new since that push ("Pull Request aktualisieren" only then)
  return o.sincePush && t.pushedSha ? { ...d, unpublished: await changedSince(p.worktree, p.gitDir, t.pushedSha) } : d;
}

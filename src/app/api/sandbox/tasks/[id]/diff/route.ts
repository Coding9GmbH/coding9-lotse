import fs from 'node:fs';
import type { TaskDiff } from '@/lib/protocol';
import { taskRoute } from '@/server/sandbox/api';
import { taskDiff } from '@/server/sandbox/diff';
import { mustTask, taskPaths } from '@/server/sandbox/tasks';

export const dynamic = 'force-dynamic';

/** "Änderungen": the workspace against the base branch (secret paths left out, redacted, at most 400 KB of patch); after a push also
 *  whether anything changed since (the "Pull Request" tab offers "aktualisieren" only then). */
export function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return taskRoute(req, async () => {
    const t = mustTask((await params).id);
    const none: TaskDiff = { files: [], diff: '', truncated: false };
    if (t.status === 'done' || !fs.existsSync(taskPaths(t.id).worktree) || !t.steps.some(s => s.key === 'clone' && s.state === 'done')) return Response.json(none);
    return Response.json(await taskDiff(t, 400 * 1024, { sincePush: true }));
  });
}

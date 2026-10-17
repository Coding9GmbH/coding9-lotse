import fs from 'node:fs';
import path from 'node:path';
import { jsonError } from '@/server/http';
import { taskRoute } from '@/server/sandbox/api';
import { SHOT_FILE } from '@/server/sandbox/screenshots';
import { mustTask, taskPaths } from '@/server/sandbox/tasks';

export const dynamic = 'force-dynamic';

/** One stored before/after screenshot of the task (PNG). Only names the task lists are served. */
export function GET(req: Request, { params }: { params: Promise<{ id: string; file: string }> }) {
  return taskRoute(req, async () => {
    const { id, file } = await params;
    const t = mustTask(id);
    const listed = [t.shots?.before, t.shots?.after].some(s => s?.items.some(i => i.file === file));
    if (!SHOT_FILE.test(file) || !listed) return jsonError(404, 'Screenshot nicht gefunden.');
    let data: Buffer;
    try { data = fs.readFileSync(path.join(taskPaths(t.id).screenshots, file)); } catch { return jsonError(404, 'Screenshot nicht gefunden.'); }
    return new Response(new Uint8Array(data), { headers: {
      'content-type': 'image/png', 'content-length': String(data.length), 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff',
      'content-disposition': `inline; filename="${t.id}-${file}"`,
    } });
  });
}

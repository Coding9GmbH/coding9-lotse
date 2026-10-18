import fs from 'node:fs';
import { jsonError } from '@/server/http';
import { auditTask, taskRoute } from '@/server/sandbox/api';
import { checkPluginZip, pluginZip } from '@/server/sandbox/plugin-zip';
import { mustTask, taskPaths } from '@/server/sandbox/tasks';
import { messages } from '@/lib/i18n';
import { requestLocale } from '@/lib/i18n/locales';
import type { PluginZipCheck } from '@/lib/protocol';

export const dynamic = 'force-dynamic';

/** Why a check fails, in one line (the UI words each problem itself; this is for a plain link and the audit). */
const problemText = (c: PluginZipCheck) => c.problems.join(', ');

/** "Plugin als ZIP herunterladen": ?check=1 answers what the ZIP would contain (problems, warnings, size); without it the ZIP is
 *  streamed as <Name>.zip for Shopware's "Erweiterung hochladen" (audited) – or 422 with the check when it cannot be built. Only while
 *  the sandbox has its working copy (not finished). */
export function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return taskRoute(req, async () => {
    const t = mustTask((await params).id), m = messages(requestLocale(req)).server;
    if (t.status === 'done' || !fs.existsSync(taskPaths(t.id).worktree) || !t.steps.some(s => s.key === 'clone' && s.state === 'done')) return jsonError(409, m.zipNotReady);
    if (new URL(req.url).searchParams.get('check') === '1') return Response.json(checkPluginZip(t));
    const { check, stream } = pluginZip(t);
    if (!stream || !check.name) {
      const why = check.problems.includes('secret') && check.secretFile ? m.zipSecret(check.secretFile) : m.zipInvalid(problemText(check));
      return Response.json({ error: why, check }, { status: 422 });
    }
    auditTask(t, 'zip', { plugin: check.name, version: check.version, files: check.files, bytes: check.bytes, vendor: check.vendor });
    const file = `${check.name}${check.version ? `-${check.version.replace(/[^A-Za-z0-9._-]/g, '')}` : ''}.zip`;
    return new Response(stream, { headers: {
      'content-type': 'application/zip', 'content-disposition': `attachment; filename="${file}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    } });
  });
}

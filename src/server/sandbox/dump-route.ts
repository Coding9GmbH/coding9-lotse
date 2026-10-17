import 'server-only';
// Frame of the dump routes: like the task routes (403 while off, actor), plus DumpError → JSON with its extra fields (received bytes for resuming).
import { auditAdd } from '../db';
import { taskRoute } from './api';
import { DumpError } from './dumps';
import type { CodeDumpRow } from '../db';

export const dumpRoute = (req: Request, fn: () => Promise<Response>) => taskRoute(req, async () => {
  try { return await fn(); } catch (e) {
    if (e instanceof DumpError) return Response.json({ error: e.message, ...e.extra }, { status: e.status });
    throw e;
  }
});
/** Audit: name, size and checksum only. */
export const auditDump = (d: Pick<CodeDumpRow, 'id' | 'name' | 'size' | 'sha256'>, action: 'upload' | 'delete') =>
  auditAdd({ decision: 'changed', kind: 'sandbox-dump', dumpId: d.id, action, title: `Datenbank-Dump: ${d.name}`, size: d.size, ...(d.sha256 ? { sha256: d.sha256 } : {}) });

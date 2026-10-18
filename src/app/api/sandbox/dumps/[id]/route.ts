import type { NextRequest } from 'next/server';
import { auditDump, dumpRoute } from '@/server/sandbox/dump-route';
import { deleteStoredDb } from '@/server/sandbox/db-snapshots';
import { DumpError, appendChunk, deleteDump, getDump, publicDump } from '@/server/sandbox/dumps';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** Metadata only (received bytes for resuming); the content is never returned. */
export function GET(req: NextRequest, { params }: Ctx) {
  return dumpRoute(req, async () => Response.json({ dump: publicDump(getDump((await params).id)) }));
}

/** One chunk (raw body, at most 16 MB) at ?offset= (the bytes received so far). Optional header x-chunk-sha256. */
export function PUT(req: NextRequest, { params }: Ctx) {
  return dumpRoute(req, async () => {
    const id = (await params).id;
    const raw = req.nextUrl.searchParams.get('offset') ?? '';
    if (!/^\d{1,15}$/.test(raw)) throw new DumpError('offset fehlt oder ist ungültig.', 400);
    const len = req.headers.get('content-length');
    const { received } = await appendChunk(id, Number(raw), req.body, { length: len && /^\d+$/.test(len) ? Number(len) : null, sha256: req.headers.get('x-chunk-sha256')?.trim().toLowerCase() || null });
    return Response.json({ received });
  });
}

/** Discard an upload that no task uses yet, or delete a stored database: its file and its snapshot volumes (tasks that already
 *  imported it keep their own copy). */
export function DELETE(req: NextRequest, { params }: Ctx) {
  return dumpRoute(req, async () => {
    const d = getDump((await params).id);
    if (d.library && d.status !== 'deleted') {
      const { volumesLeft } = await deleteStoredDb(d.id);
      auditDump(d, 'delete');
      return Response.json({ ok: true, ...(volumesLeft ? { volumesLeft } : {}) });
    }
    if (d.taskId && d.status !== 'deleted') throw new DumpError('Der Dump gehört zu einer Aufgabe und wird dort nach dem Import gelöscht.', 409);
    deleteDump(d.id);
    auditDump(d, 'delete');
    return Response.json({ ok: true });
  });
}

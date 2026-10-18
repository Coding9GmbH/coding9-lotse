import { z } from 'zod';
import { currentActor } from '@/server/actor';
import { parseJson } from '@/server/http';
import { dumpRoute } from '@/server/sandbox/dump-route';
import { createDump, libraryDumps, publicDump, publicLibraryDump } from '@/server/sandbox/dumps';
import { snapshotsEnabled } from '@/server/sandbox/db-snapshots';
import { getSandboxConfig } from '@/server/sandbox/env';

export const dynamic = 'force-dynamic';

const schema = z.object({ name: z.string().max(200), size: z.number().int().positive(), keep: z.boolean().optional() }).strict();

/** "Gespeicherte Datenbanken": the complete stored databases (metadata only), with whether a quick-start snapshot exists for the configured image. */
export function GET(req: Request) {
  return dumpRoute(req, async () => {
    const image = snapshotsEnabled() ? getSandboxConfig().image : null;
    return Response.json({ dumps: libraryDumps().map(d => publicLibraryDump(d, image)) });
  });
}

/** Announce an upload (name and total size; keep = store it for further sandboxes); the chunks follow with PUT /api/sandbox/dumps/<id>?offset=… */
export function POST(req: Request) {
  return dumpRoute(req, async () => {
    const body = await parseJson(req, schema);
    if (!body.ok) return body.res;
    return Response.json({ dump: publicDump(createDump(body.data.name, body.data.size, Date.now(), { library: !!body.data.keep, uploadedBy: currentActor() })) }, { status: 201 });
  });
}

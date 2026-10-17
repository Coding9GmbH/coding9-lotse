import { z } from 'zod';
import { parseJson } from '@/server/http';
import { dumpRoute } from '@/server/sandbox/dump-route';
import { createDump, publicDump } from '@/server/sandbox/dumps';

export const dynamic = 'force-dynamic';

const schema = z.object({ name: z.string().max(200), size: z.number().int().positive() }).strict();

/** Announce an upload (name and total size); the chunks follow with PUT /api/sandbox/dumps/<id>?offset=… */
export function POST(req: Request) {
  return dumpRoute(req, async () => {
    const body = await parseJson(req, schema);
    if (!body.ok) return body.res;
    return Response.json({ dump: publicDump(createDump(body.data.name, body.data.size)) }, { status: 201 });
  });
}

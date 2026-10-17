import { z } from 'zod';
import { parseJson } from '@/server/http';
import { auditDump, dumpRoute } from '@/server/sandbox/dump-route';
import { completeDump, publicDump } from '@/server/sandbox/dumps';

export const dynamic = 'force-dynamic';

const schema = z.object({ sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional() }).strict();

/** All chunks there: size, checksum and content type (gzip or SQL) are checked; a bad file is deleted (415/422). */
export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return dumpRoute(req, async () => {
    const body = await parseJson(req, schema);
    if (!body.ok) return body.res;
    const d = await completeDump((await params).id, body.data.sha256 ?? null);
    auditDump(d, 'upload');
    return Response.json({ dump: publicDump(d) });
  });
}

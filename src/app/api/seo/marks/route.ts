import { z } from 'zod';
import { setSeoMark } from '@/server/features/seo-overview';
import { parseJson } from '@/server/http';

export const dynamic = 'force-dynamic';

// Mark SEO levers as done/ignored (state null = show again). Changes only Lotse, nothing in the shop.
const schema = z.object({ id: z.string().min(1).max(300).regex(/^(gsc|sistrix|site):/), state: z.enum(['done', 'ignored']).nullable() });

export async function PUT(req: Request) {
  const body = await parseJson(req, schema);
  if (!body.ok) return body.res;
  return Response.json({ mark: setSeoMark(body.data.id, body.data.state) });
}

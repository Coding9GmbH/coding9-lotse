import { z } from 'zod';
import { parseJson } from '@/server/http';
import { loadStyleguide, saveStyleguide } from '@/server/styleguide';

export const dynamic = 'force-dynamic';

// Wie bisher wird der Styleguide als Ganzes gespeichert; geprüft werden nur Form und Typen der bekannten Felder.
const str = z.string().optional();
const schema = z.looseObject({
  brandName: str, summary: str, imagery: str, logoUrl: str, layoutNotes: str,
  colors: z.record(z.string(), z.string().nullable()).optional(),
  typography: z.looseObject({}).optional(),
  shape: z.looseObject({}).optional(),
  tone: z.looseObject({ formality: z.enum(['Du', 'Sie']).optional(), dos: z.array(z.string()).optional(), donts: z.array(z.string()).optional(), examples: z.array(z.string()).optional() }).optional(),
});

export function GET() {
  return Response.json(loadStyleguide());
}

export async function PUT(req: Request) {
  const body = await parseJson(req, schema);
  if (!body.ok) return body.res;
  return Response.json(saveStyleguide(body.data as Parameters<typeof saveStyleguide>[0]));
}

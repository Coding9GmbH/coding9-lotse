import { z } from 'zod';
import { TITLE_MAX } from '@/lib/knowledge';
import { errMsg, jsonError, parseJson } from '@/server/http';
import { addDocument, docByFileId, extractFromFile, listDocs, listRules } from '@/server/knowledge';
import { linkSchema } from './schema';

export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ docs: listDocs(), rules: listRules() });
}

// Add a document from a file previously uploaded via /api/files
const schema = z.object({ fileId: z.string().min(1), title: z.string().max(TITLE_MAX).optional(), tags: z.array(z.string()).max(20).optional(), links: z.array(linkSchema).max(200).optional() });

export async function POST(req: Request) {
  const body = await parseJson(req, schema);
  if (!body.ok) return body.res;
  const { fileId, title, tags, links } = body.data;
  if (docByFileId(fileId)) return jsonError(409, 'Diese Datei ist bereits in der Wissensbasis.');
  try {
    const x = await extractFromFile(fileId);
    return Response.json(addDocument({ ...x, source: 'upload' }, { title: title || (x.fileName ?? '').replace(/\.[a-z0-9]+$/i, ''), tags, links }));
  } catch (e) { return jsonError(400, errMsg(e)); }
}

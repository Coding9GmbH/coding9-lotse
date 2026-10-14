import 'server-only';
// Small helpers for route handlers: read JSON body + validate with zod (400 with German message), body limit.
import { z } from 'zod';

const JSON_LIMIT = 2 * 1024 * 1024; // as before express.json({ limit: '2mb' })

export { errMsg } from './util';
export const jsonError = (status: number, error: string) => Response.json({ error }, { status });

/** Reads a request/response body with a size limit: Content-Length checked up front, counted while streaming,
 *  aborted as soon as the limit is exceeded (no unbounded arrayBuffer()). null = too large. */
export async function readLimited(src: { headers: Headers; body: ReadableStream<Uint8Array> | null }, max: number): Promise<Buffer | null> {
  const len = Number(src.headers.get('content-length') ?? '');
  if (Number.isFinite(len) && len > max) { await src.body?.cancel().catch(() => {}); return null; }
  if (!src.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = []; let size = 0;
  const reader = src.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
/** Request body with a size limit. null = too large. */
export const readBodyLimited = (req: Request, max: number) => readLimited(req, max);

const deError = z.locales.de().localeError; // German error messages only for REST validation (tool schemas stay unchanged)
const describe = (err: z.ZodError) => err.issues.slice(0, 3).map(i => `${i.path.join('.') || 'Body'}: ${i.message}`).join('; ');

/** Read and validate the JSON body. Returns either the data or a ready-made error response. */
export async function parseJson<S extends z.ZodType>(req: Request, schema: S, onError: (msg: string, status: number) => Response = (m, s) => jsonError(s, m)):
  Promise<{ ok: true; data: z.infer<S> } | { ok: false; res: Response }> {
  const buf = await readBodyLimited(req, JSON_LIMIT);
  if (!buf) return { ok: false, res: onError('Anfrage zu groß (max. 2 MB).', 413) };
  let raw: unknown;
  try { raw = JSON.parse(buf.toString('utf8') || 'null'); } catch { return { ok: false, res: onError('Ungültige Anfrage: Body ist kein gültiges JSON.', 400) }; }
  const r = schema.safeParse(raw, { error: deError });
  if (!r.success) return { ok: false, res: onError(`Ungültige Anfrage: ${describe(r.error)}`, 400) };
  return { ok: true, data: r.data };
}

export const chatIdSchema = z.string().min(1, 'chatId fehlt').max(200);

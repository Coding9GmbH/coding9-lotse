import 'server-only';
// Kleine Helfer für die Route-Handler: JSON-Body lesen + mit zod prüfen (400 mit deutscher Meldung), Body-Limit.
import { z } from 'zod';

const JSON_LIMIT = 2 * 1024 * 1024; // wie bisher express.json({ limit: '2mb' })

export { errMsg } from './util';
export const jsonError = (status: number, error: string) => Response.json({ error }, { status });

/** Liest den Body mit Größenlimit (Abbruch, sobald das Limit überschritten ist). null = zu groß. */
export async function readBodyLimited(req: Request, max: number): Promise<Buffer | null> {
  const len = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(len) && len > max) return null;
  if (!req.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = []; let size = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

const deError = z.locales.de().localeError; // deutsche Fehlermeldungen nur für die REST-Prüfung (Tool-Schemas bleiben unverändert)
const describe = (err: z.ZodError) => err.issues.slice(0, 3).map(i => `${i.path.join('.') || 'Body'}: ${i.message}`).join('; ');

/** JSON-Body lesen und prüfen. Liefert entweder die Daten oder eine fertige Fehlerantwort. */
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

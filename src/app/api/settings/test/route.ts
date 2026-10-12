import { z } from 'zod';
import type { TestResult } from '@/lib/protocol';
import { pingAi } from '@/server/agent';
import { errMsg, parseJson } from '@/server/http';
import { activePlatform } from '@/server/platform';

export const dynamic = 'force-dynamic';

const schema = z.object({ target: z.string() });
const result = (r: TestResult, status = 200) => Response.json(r, { status });

export async function POST(req: Request) {
  const body = await parseJson(req, schema, (message, status) => result({ ok: false, message }, status));
  if (!body.ok) return body.res;
  const { target } = body.data;
  try {
    if (target === 'shop' || target === 'shopware') return result(await activePlatform().testConnection()); // 'shopware' = Altbestand
    if (target === 'ai') { const text = await pingAi(); return result({ ok: true, message: `KI antwortet: ${String(text).slice(0, 40)}` }); }
    return result({ ok: false, message: 'unbekanntes Ziel' }, 400);
  } catch (e) { return result({ ok: false, message: errMsg(e).replace(/\s+/g, ' ').slice(0, 300) }); }
}

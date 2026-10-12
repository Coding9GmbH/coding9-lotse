import type { NextRequest } from 'next/server';
import { errMsg, jsonError } from '@/server/http';
import { activePlatform } from '@/server/platform';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const q = req.nextUrl.searchParams;
    return Response.json(await activePlatform().context.products({ term: q.get('term'), categoryId: q.get('categoryId') }));
  } catch (e) { return jsonError(500, errMsg(e)); }
}

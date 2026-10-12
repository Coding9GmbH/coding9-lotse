import { errMsg, jsonError } from '@/server/http';
import { activePlatform } from '@/server/platform';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return Response.json(await activePlatform().context.categories());
  } catch (e) { return jsonError(500, errMsg(e)); }
}

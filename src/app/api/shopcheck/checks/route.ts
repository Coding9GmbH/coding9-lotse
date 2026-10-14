import { checkList } from '@/server/custom-checks';
import { activePlatform } from '@/server/platform';

export const dynamic = 'force-dynamic';

// All checks of the active platform (built-in + custom) with their on/off state
export async function GET() {
  const p = activePlatform();
  await import('@/server/features'); await p.loadChecks();
  return Response.json(checkList(p.kind));
}

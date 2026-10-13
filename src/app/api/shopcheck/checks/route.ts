import { checkList } from '@/server/custom-checks';
import { activePlatform } from '@/server/platform';

export const dynamic = 'force-dynamic';

// Alle Prüfungen der aktiven Plattform (eingebaut + eigene) mit Zustand an/aus
export async function GET() {
  const p = activePlatform();
  await import('@/server/features'); await p.loadChecks();
  return Response.json(checkList(p.kind));
}

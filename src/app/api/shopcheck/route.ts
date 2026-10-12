import { shopCheckState } from '@/server/shopcheck';

export const dynamic = 'force-dynamic';

// Gespeichertes Ergebnis + läuft-Flag; veraltet (> 6 Std.) → Neuprüfung startet im Hintergrund
export function GET() {
  return Response.json(shopCheckState());
}

// „Neu prüfen“: startet sofort im Hintergrund und antwortet direkt
export function POST() {
  return Response.json(shopCheckState({ refresh: true }));
}

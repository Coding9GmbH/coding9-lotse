import { shopCheckState } from '@/server/shopcheck';

export const dynamic = 'force-dynamic';

// Stored result + running flag; stale (> 6 h) → a re-check starts in the background
export function GET() {
  return Response.json(shopCheckState());
}

// "Neu prüfen" (re-check): starts immediately in the background and responds right away
export function POST() {
  return Response.json(shopCheckState({ refresh: true }));
}

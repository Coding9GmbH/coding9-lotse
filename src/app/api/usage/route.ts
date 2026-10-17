import { usageStatus } from '@/server/usage';

export const dynamic = 'force-dynamic';

// AI costs of this month and the last 30 days per day, plus the monthly budget (cost brake). Read-only, no shop access.
export function GET() {
  return Response.json(usageStatus());
}

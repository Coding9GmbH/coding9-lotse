import { accessList } from '@/server/db';

export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json(accessList(150));
}

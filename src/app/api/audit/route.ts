import { auditList } from '@/server/db';

export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json(auditList(100));
}

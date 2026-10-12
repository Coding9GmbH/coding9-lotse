import { chatListLive } from '@/server/sessions';

export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json(chatListLive());
}

import type { AppConfig } from '@/lib/protocol';
import { imageGenAvailable } from '@/server/media';
import { activePlatform } from '@/server/platform';
import { inDocker } from '@/server/settings';

export const dynamic = 'force-dynamic';

export async function GET() {
  const p = activePlatform();
  const u = await p.urls();
  const out: AppConfig = { admin: u.admin, storefront: u.storefront, imageGen: imageGenAvailable(), docker: inDocker(), version: process.env.LOTSE_VERSION || 'dev', platform: p.kind, paths: u.paths };
  return Response.json(out);
}

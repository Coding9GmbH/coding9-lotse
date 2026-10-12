// Healthcheck (ohne Login, siehe proxy.ts)
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ ok: true, version: process.env.LOTSE_VERSION || 'dev' });
}

import { cancelCodexLogin, codexLoginState, codexLogout, startCodexLogin } from '@/server/codex';
import { errMsg } from '@/server/http';

export const dynamic = 'force-dynamic';

// ChatGPT-Anmeldung für Codex per Gerätecode: POST startet (liefert Link + Code), GET fragt den Stand ab, DELETE meldet ab.
export async function POST() {
  try { return Response.json(await startCodexLogin()); } catch (e) { return Response.json({ status: 'error', message: errMsg(e) }); }
}
export function GET() { return Response.json(codexLoginState()); }
export function DELETE(req: Request) {
  if (new URL(req.url).searchParams.get('cancel')) cancelCodexLogin(); else codexLogout();
  return Response.json(codexLoginState());
}

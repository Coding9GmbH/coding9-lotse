import { cancelCodexLogin, codexLoginState, codexLogout, startCodexLogin } from '@/server/codex';
import { errMsg } from '@/server/http';

export const dynamic = 'force-dynamic';

// ChatGPT sign-in for Codex via device code: POST starts it (returns link + code), GET polls the status, DELETE signs out.
export async function POST() {
  try { return Response.json(await startCodexLogin()); } catch (e) { return Response.json({ status: 'error', message: errMsg(e) }); }
}
export function GET() { return Response.json(codexLoginState()); }
export function DELETE(req: Request) {
  if (new URL(req.url).searchParams.get('cancel')) cancelCodexLogin(); else codexLogout();
  return Response.json(codexLoginState());
}

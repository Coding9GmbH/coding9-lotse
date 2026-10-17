import { z } from 'zod';
import { auditAdd } from '@/server/db';
import { errMsg, jsonError, parseJson } from '@/server/http';
import { githubPublic, saveGithub } from '@/server/github';

export const dynamic = 'force-dynamic';

// GitHub: the token only goes in, never out. All that comes back is whether one is stored (plus the login after a test).
const schema = z.object({ token: z.string().min(1).max(300) });
const audit = (title: string) => auditAdd({ decision: 'changed', kind: 'settings', title, fields: { githubToken: 'geändert' } }); // field names only, never values

export function GET() {
  return Response.json(githubPublic());
}

export async function PUT(req: Request) {
  const body = await parseJson(req, schema);
  if (!body.ok) return body.res;
  try { saveGithub(body.data); } catch (e) { return jsonError(400, errMsg(e)); }
  audit('GitHub-Token gespeichert');
  return Response.json(githubPublic());
}

export function DELETE() {
  const had = githubPublic().hasToken;
  saveGithub({ token: null });
  if (had) audit('GitHub-Verbindung getrennt');
  return Response.json(githubPublic());
}

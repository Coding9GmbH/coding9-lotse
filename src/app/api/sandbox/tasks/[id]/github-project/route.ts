import { z } from 'zod';
import { requestLocale } from '@/lib/i18n/locales';
import { parseJson } from '@/server/http';
import { taskRoute } from '@/server/sandbox/api';
import { createGithubProject } from '@/server/sandbox/github-project';

export const dynamic = 'force-dynamic';

const schema = z.object({ owner: z.string().min(1).max(39), name: z.string().min(1).max(100) }).strict();

/** "Als GitHub-Projekt anlegen" for a sandbox started without a project: a new private repository with its local start as main. */
export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return taskRoute(req, async () => {
    const body = await parseJson(req, schema);
    if (!body.ok) return body.res;
    return Response.json({ task: await createGithubProject((await params).id, body.data, requestLocale(req)) }, { status: 201 });
  });
}

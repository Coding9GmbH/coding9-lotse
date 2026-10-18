import { z } from 'zod';
import { parseJson } from '@/server/http';
import { taskRoute } from '@/server/sandbox/api';
import { createQuickStart, duplicateQuickStart, freeName, listQuickStarts, setupOfTask } from '@/server/sandbox/quick-starts';
import { mustTask } from '@/server/sandbox/tasks';
import { requestLocale } from '@/lib/i18n/locales';

export const dynamic = 'force-dynamic';

const schema = z.object({
  name: z.string().max(200).optional(),
  /** the start dialog's request without the chat (checked like a start) */ setup: z.unknown().optional(),
  /** "Setup als Schnellstart speichern" of a sandbox */ fromTask: z.string().max(40).optional(),
  /** "Duplizieren" */ duplicateOf: z.string().max(40).optional(),
  isDefault: z.boolean().optional(),
}).strict();

/** Quick starts (A22), sorted by name; `default` marks the one "Sandbox starten" preselects. */
export function GET(req: Request) {
  return taskRoute(req, async () => Response.json({ quickStarts: listQuickStarts() }));
}

/** Save a setup as a quick start: the dialog's request, a sandbox's setup or a copy of another quick start. */
export function POST(req: Request) {
  return taskRoute(req, async () => {
    const body = await parseJson(req, schema);
    if (!body.ok) return body.res;
    const { name, setup, fromTask, duplicateOf, isDefault } = body.data, locale = requestLocale(req);
    if (duplicateOf) return Response.json({ quickStart: duplicateQuickStart(duplicateOf, locale) }, { status: 201 });
    if (fromTask) {
      const t = mustTask(fromTask);
      return Response.json({ quickStart: createQuickStart({ name: name?.trim() || freeName(t.title), setup: setupOfTask(t, locale), isDefault }, locale) }, { status: 201 });
    }
    return Response.json({ quickStart: createQuickStart({ name: name ?? '', setup, isDefault }, locale) }, { status: 201 });
  });
}

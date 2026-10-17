// Registry of sandbox templates. Only "dockware-play" exists; more templates are added here as code.
import type { TemplateDescriptor } from '@/lib/protocol';
import { dockwarePlay } from './dockware-play';
import type { CommandCtx, SandboxTemplate } from './types';

export const TEMPLATES: Record<string, SandboxTemplate> = { [dockwarePlay.id]: dockwarePlay };
export const DEFAULT_TEMPLATE = dockwarePlay.id;

export function getTemplate(id: string): SandboxTemplate {
  const t = Object.hasOwn(TEMPLATES, id) ? TEMPLATES[id] : undefined;
  if (!t) throw new Error(`Unbekannte Sandbox-Vorlage: ${id}`);
  return t;
}

/** What the UI needs to show a template (no functions, no patterns to evaluate). */
export const describeTemplate = (t: SandboxTemplate): TemplateDescriptor => ({
  id: t.id, platform: t.platform, defaultImage: t.defaultImage, imagePattern: t.imagePattern.source,
  steps: t.steps.map(s => ({ id: s.id, ...(s.custom ? { custom: s.custom } : {}), ...(s.optional ? { optional: true } : {}) })),
  commands: t.commands.map(c => ({ id: c.id, args: c.args.map(a => a.name) })),
});

const PLUGIN_DIR = /^custom\/plugins\/[A-Z][A-Za-z0-9]{1,60}$/;

/** Allow-listed command → argv. Unknown ids, unknown or missing args and args outside their pattern are refused. */
export function resolveCommand(t: SandboxTemplate, id: string, args: Record<string, string> = {}, ctx: CommandCtx) {
  const spec = t.commands.find(c => c.id === id);
  if (!spec) throw new Error(`Befehl „${id}“ ist in dieser Vorlage nicht erlaubt.`);
  if (!PLUGIN_DIR.test(ctx.pluginDir)) throw new Error('Ungültiges Plugin-Verzeichnis.');
  const allowed = new Set(spec.args.map(a => a.name));
  const extra = Object.keys(args).find(k => !allowed.has(k));
  if (extra) throw new Error(`Unbekanntes Argument „${extra}“ für ${id}.`);
  for (const a of spec.args) {
    const v = args[a.name];
    if (typeof v !== 'string' || !a.pattern.test(v)) throw new Error(`Ungültiger Wert für „${a.name}“ (${id}): nur relative Pfade im Plugin, ohne „..“ und Sonderzeichen.`);
  }
  return { argv: spec.argv(args, ctx), user: spec.user, workdir: spec.workdir, timeoutMs: spec.timeoutMs, maxOutput: spec.maxOutput };
}

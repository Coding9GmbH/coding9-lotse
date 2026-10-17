// Registry of sandbox templates. Only "dockware" is enabled; more templates are added here as code. "shopify-theme" is a prepared,
// disabled stub that shows the shape of a template without a container (see docs/architektur.md, "Weitere Vorlagen").
import type { TemplateDescriptor } from '@/lib/protocol';
import { dockware } from './dockware';
import { shopifyTheme } from './shopify-theme';
import type { AnyTemplate, CommandCtx, SandboxTemplate } from './types';

/** Every known template, enabled or not. */
export const REGISTRY: readonly AnyTemplate[] = [dockware, shopifyTheme];
/** The templates that can run: enabled, with a container (the setup, the runner and the preview need one today). */
export const TEMPLATES: Record<string, SandboxTemplate> = Object.fromEntries(REGISTRY.filter((t): t is SandboxTemplate => t.enabled && t.runtime === 'container').map(t => [t.id, t]));
export const DEFAULT_TEMPLATE = dockware.id;
/** Earlier ids still stored in settings or task rows. */
const RENAMED: Record<string, string> = { 'dockware-play': dockware.id };
export const canonicalTemplateId = (id: string) => (Object.hasOwn(RENAMED, id) ? RENAMED[id] : id);

export function getTemplate(id: string): SandboxTemplate {
  const key = canonicalTemplateId(id);
  const t = Object.hasOwn(TEMPLATES, key) ? TEMPLATES[key] : undefined;
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

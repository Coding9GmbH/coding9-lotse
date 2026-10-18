import 'server-only';
// Quick starts ("Schnellstarts", A22): saved setups of "Sandbox starten". A quick start is the dialog's request without the chat
// (start.ts checks and starts it like the dialog's own), kept in kv 'sandbox-quick-starts' (at most 50, one of them the default).
// - secret values never get in: a variable whose name is a secret of the environment, or whose value contains one, is kept by name only;
//   a secret in any other text (command, notes, start page, …) is refused with the field's name
// - the stored database is referenced by id; a one-off dump cannot be kept
// - on every use: GitHub access, the base branch, the stored database and the image are checked again; a problem opens the dialog
// - the approval of a repository's .lotse/sandbox.json is not part of it: the setup asks as usual (per repository + file content)
// - create, update, delete and use are audited (names and ids only)
import crypto from 'node:crypto';
import { z } from 'zod';
import { DEFAULT_LOCALE, messages, type Locale } from '@/lib/i18n';
import type { QuickStartProblem, QuickStartPublic, QuickStartSetup, StartKind } from '@/lib/protocol';
import { auditAdd, codeDumpGet, kvGet, kvSet } from '../db';
import { currentActor } from '../actor';
import { assertBaseBranch } from '../git';
import { assertRepoName, branchExists, checkRepoAccess, githubConnected } from '../github';
import { plausibleSecret, weakCredentialIn } from '../secret-values';
import { knownSecrets, weakSecrets } from '../settings';
import { errMsg } from '../util';
import { ENV_KEY, getSandboxConfig, imageTag } from './env';
import { setupFields, startSandbox } from './start';
import { checkSetup, type CodeTask } from './tasks';

const KV = 'sandbox-quick-starts';
export const QUICK_MAX = 50;
const NAME_MAX = 80;
export const QUICK_ID = /^qs_[a-z0-9]{10}$/;
interface StoredQuickStart { id: string; name: string; setup: QuickStartSetup; createdAt: string; updatedAt: string; createdBy: string | null; lastUsedAt: string | null }
interface Store { items: StoredQuickStart[]; defaultId: string | null }
const load = (): Store => { const s = kvGet<Store>(KV); return { items: Array.isArray(s?.items) ? s.items : [], defaultId: s?.defaultId ?? null }; };
const save = (s: Store) => kvSet(KV, s);
const now = () => new Date().toISOString();
const newId = () => `qs_${Array.from(crypto.randomBytes(10), b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('')}`;
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const M = (locale: Locale) => messages(locale).server.quickStart;

/** Finds a stored secret in a text: the environment's secret variables (with their name) and Lotse's other stored secrets (GitHub token,
 *  AI key, shop access …; name null). Like the secret scan, a plausible secret counts anywhere, a weak one ("admin123") only where it
 *  stands as a credential's value; a variable's value (`asValue`) holds an environment secret as soon as it contains it. Values of 3
 *  characters or less are not searched (they would match almost any text), as in redact(). */
function secretFinder(): (text: string, asValue?: boolean) => { key: string | null } | null {
  const cfg = getSandboxConfig(), secretKeys = new Set(cfg.envVars.filter(x => x.secret).map(x => x.key));
  const named = cfg.env.map(e => { const i = e.indexOf('='); return { key: e.slice(0, i), value: e.slice(i + 1) }; }).filter(e => secretKeys.has(e.key) && e.value.length > 3);
  const plain = knownSecrets(), weak = weakSecrets();
  return (text, asValue = false) => {
    const n = named.find(e => (asValue || plausibleSecret(e.value) ? text.includes(e.value) : weakCredentialIn(text, e.value)));
    if (n) return { key: n.key };
    return plain.some(x => text.includes(x)) || weak.some(x => (asValue && text === x) || weakCredentialIn(text, x)) ? { key: null } : null;
  };
}

/** The dialog's request as a quick start keeps it: the start fields without the title, plus the dialog's first step */
const setupSchema = z.object(setupFields).omit({ title: true }).extend({
  kind: z.enum(['existing', 'new', 'none', 'custom']),
  envRefs: z.array(z.string().regex(ENV_KEY)).max(50).optional(),
}).strict();

/** A quick start's setup, checked with the start dialog's rules (checkSetup). Secret values are dropped (kept as envRefs), the database
 *  must be a stored one. Throws status 400 with a German/English message. */
export function normalizeSetup(raw: unknown, locale: Locale = DEFAULT_LOCALE): QuickStartSetup {
  const r = setupSchema.safeParse(raw);
  if (!r.success) throw fail(400, M(locale).invalid(r.error.issues.slice(0, 3).map(i => `${i.path.join('.') || '(setup)'}: ${i.message}`).join('; ')));
  const v = r.data, kind: StartKind = v.kind;
  const none = kind === 'none' || v.source === 'none';
  // the environment's secrets stay in the environment: such a variable is remembered by its name only
  const cfg = getSandboxConfig(), secretKeys = new Set(cfg.envVars.filter(x => x.secret).map(x => x.key)), find = secretFinder();
  const refs = new Set(none ? [] : v.envRefs ?? []), env: { key: string; value: string }[] = [];
  for (const e of none ? [] : v.env ?? []) {
    const key = e.key.trim();
    if (secretKeys.has(key) || find(e.value, true)) { if (ENV_KEY.test(key)) refs.add(key); } else env.push({ key, value: e.value });
  }
  for (const e of env) refs.delete(e.key); // a plain value given for it replaces the reference
  // every other text of the setup must not hold a secret either (it is stored, listed and given to the AI): refused, naming the field
  const f = M(locale).field, texts: [string, string | undefined][] = [
    [f.repo, v.repo], [f.branch, v.baseBranch], [f.pluginName, v.pluginName], [f.targetPath, v.targetPath], [f.image, v.image], [f.previewPath, v.previewPath], [f.notes, v.notes],
    ...(none ? [] : v.commands ?? []).flatMap((c, i): [string, string][] => [[f.commandLabel(i + 1), c.label], [f.command(i + 1), c.command]]),
    ...(none ? [] : v.env ?? []).map((e, i): [string, string] => [f.varKey(i + 1), e.key]),
  ];
  for (const [field, text] of texts) {
    const hit = text ? find(text) : null;
    if (hit) throw fail(400, M(locale).secret(field, hit.key));
  }
  const mode = kind === 'custom' ? 'custom' : none ? 'auto' : v.mode;
  const s = checkSetup({ ...v, source: none ? 'none' : 'repo', mode, env, commands: none ? [] : v.commands }, locale);
  if (!none) { try { assertRepoName(v.repo); } catch (e) { throw fail(400, errMsg(e)); } }
  if (v.dumpId) { const d = codeDumpGet(v.dumpId); if (!d?.library || d.status !== 'ready') throw fail(400, M(locale).dumpOnly); }
  return {
    kind: none ? 'none' : kind, repo: none ? '' : v.repo, baseBranch: none ? '' : v.baseBranch.trim(),
    ...(v.pluginName && (none || kind === 'new' || kind === 'existing') ? { pluginName: v.pluginName } : {}),
    ...(none ? { source: 'none' as const } : {}), ...(!none && s.mode !== 'auto' ? { mode: s.mode } : {}), ...(s.targetPath ? { targetPath: s.targetPath } : {}),
    ...(s.commands.length ? { commands: s.commands.map(c => ({ label: c.label, command: c.command, phase: c.phase })) } : {}),
    ...(s.env.length ? { env: s.env } : {}), ...(v.dumpId ? { dumpId: v.dumpId } : {}),
    ...(s.image ? { image: s.image } : {}), ...(s.previewPath ? { previewPath: s.previewPath } : {}), ...(s.notes ? { notes: s.notes } : {}),
    ...(refs.size ? { envRefs: [...refs].slice(0, 50) } : {}),
  };
}

/** "Setup als Schnellstart speichern" of a running sandbox: what its start dialog chose (no secrets: a task keeps plain values only) */
export function setupOfTask(t: CodeTask, locale: Locale = DEFAULT_LOCALE): QuickStartSetup {
  const s = t.setup;
  if (!s) throw fail(409, M(locale).taskNoSetup);
  const none = s.source === 'none';
  const kind: StartKind = none ? 'none' : s.mode === 'custom' ? 'custom' : t.layout?.isNew || (t.pluginName && !t.layout) ? 'new' : 'existing';
  const dump = t.dump?.library && !t.dump.deletedAt ? codeDumpGet(t.dump.id) : null;
  return normalizeSetup({
    kind, repo: none ? '' : t.repo, baseBranch: none ? '' : t.baseBranch, ...(t.pluginName && (none || kind === 'new') ? { pluginName: t.pluginName } : {}),
    ...(none ? { source: 'none' } : {}), mode: s.mode, ...(s.targetPath ? { targetPath: s.targetPath } : {}),
    commands: s.commands.map(c => ({ label: c.label, command: c.command, phase: c.phase })), env: s.env,
    ...(dump?.library && dump.status === 'ready' ? { dumpId: dump.id } : {}),
    ...(s.image ? { image: s.image } : {}), ...(s.previewPath ? { previewPath: s.previewPath } : {}), ...(s.notes ? { notes: s.notes } : {}),
  }, locale);
}

const pub = (q: StoredQuickStart, defaultId: string | null): QuickStartPublic => ({ ...q, default: q.id === defaultId });
export function listQuickStarts(): QuickStartPublic[] {
  const s = load();
  return [...s.items].sort((a, b) => a.name.localeCompare(b.name, 'de')).map(q => pub(q, s.defaultId));
}
export function getQuickStart(id: string, locale: Locale = DEFAULT_LOCALE): QuickStartPublic {
  const s = load(), q = QUICK_ID.test(id) ? s.items.find(x => x.id === id) : undefined;
  if (!q) throw fail(404, M(locale).gone);
  return pub(q, s.defaultId);
}

function checkName(raw: string, items: StoredQuickStart[], self: string | null, locale: Locale): string {
  const name = raw.replace(/\s+/g, ' ').trim();
  if (!name || name.length > NAME_MAX || /[\x00-\x1f\x7f]/.test(name)) throw fail(400, M(locale).name);
  if (items.some(x => x.id !== self && x.name.toLowerCase() === name.toLowerCase())) throw fail(409, M(locale).nameTaken(name));
  return name;
}
const audit = (q: Pick<StoredQuickStart, 'id' | 'name' | 'setup'>, action: 'create' | 'update' | 'delete' | 'use', extra: Record<string, unknown> = {}) =>
  auditAdd({ decision: 'changed', kind: 'sandbox-quick-start', action, quickStartId: q.id, title: `Schnellstart: ${q.name}`, ...(q.setup.repo ? { repo: q.setup.repo } : {}), ...extra });

/** A new quick start (the setup checked like the dialog's start). `isDefault`: preselected in "Sandbox starten" from now on. */
export function createQuickStart(p: { name: string; setup: unknown; isDefault?: boolean }, locale: Locale = DEFAULT_LOCALE): QuickStartPublic {
  const s = load();
  if (s.items.length >= QUICK_MAX) throw fail(409, M(locale).limit(QUICK_MAX));
  const name = checkName(p.name, s.items, null, locale), setup = normalizeSetup(p.setup, locale), ts = now();
  const q: StoredQuickStart = { id: newId(), name, setup, createdAt: ts, updatedAt: ts, createdBy: currentActor(), lastUsedAt: null };
  s.items.push(q);
  if (p.isDefault) s.defaultId = q.id;
  save(s);
  audit(q, 'create', { ...(p.isDefault ? { default: true } : {}), ...(setup.envRefs ? { envRefs: setup.envRefs } : {}) });
  return pub(q, s.defaultId);
}

/** `base`, or "base 2", "base 3", … if a quick start has that name already */
export function freeName(base: string): string {
  const names = new Set(load().items.map(x => x.name.toLowerCase())), b = base.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX - 4);
  let name = b;
  for (let n = 2; names.has(name.toLowerCase()); n++) name = `${b} ${n}`;
  return name;
}

/** A copy under a free name "X (Kopie)", "X (Kopie) 2", … */
export function duplicateQuickStart(id: string, locale: Locale = DEFAULT_LOCALE): QuickStartPublic {
  const src = getQuickStart(id, locale);
  return createQuickStart({ name: freeName(M(locale).copy(src.name)), setup: src.setup }, locale);
}

/** Rename, replace the setup, mark as default (true) or remove the mark (false). Audited with the changed fields. */
export function updateQuickStart(id: string, p: { name?: string; setup?: unknown; isDefault?: boolean }, locale: Locale = DEFAULT_LOCALE): QuickStartPublic {
  const s = load(), q = s.items.find(x => x.id === id);
  if (!q || !QUICK_ID.test(id)) throw fail(404, M(locale).gone);
  const changed: string[] = [];
  if (p.name !== undefined) { const name = checkName(p.name, s.items, id, locale); if (name !== q.name) { q.name = name; changed.push('name'); } }
  if (p.setup !== undefined) {
    // a setup without "envRefs" keeps the saved references (an older editor did not send them); [] removes them on purpose
    const raw = p.setup && typeof p.setup === 'object' && !Array.isArray(p.setup) && !('envRefs' in p.setup) && q.setup.envRefs ? { ...p.setup, envRefs: q.setup.envRefs } : p.setup;
    const setup = normalizeSetup(raw, locale); if (JSON.stringify(setup) !== JSON.stringify(q.setup)) { q.setup = setup; changed.push('setup'); }
  }
  if (p.isDefault !== undefined && p.isDefault !== (s.defaultId === id)) { s.defaultId = p.isDefault ? id : null; changed.push('default'); }
  if (!changed.length) return pub(q, s.defaultId);
  q.updatedAt = now();
  save(s);
  audit(q, 'update', { changed });
  return pub(q, s.defaultId);
}

export function deleteQuickStart(id: string, locale: Locale = DEFAULT_LOCALE): void {
  const s = load(), q = s.items.find(x => x.id === id);
  if (!q || !QUICK_ID.test(id)) throw fail(404, M(locale).gone);
  s.items = s.items.filter(x => x.id !== id);
  if (s.defaultId === id) s.defaultId = null;
  save(s);
  audit(q, 'delete');
}

/** Checked on every use: GitHub connected, the project accessible and its base branch there, the stored database still stored, the
 *  image still allowed, the setup still valid (rules may have changed). Missing environment variables are only a warning. */
export async function checkQuickStart(q: QuickStartPublic, locale: Locale = DEFAULT_LOCALE): Promise<{ problems: QuickStartProblem[]; warnings: string[] }> {
  const m = M(locale), problems: QuickStartProblem[] = [], warnings: string[] = [], s = q.setup;
  // the rules of the dialog may have changed since it was saved (the database and the image are named below with their own message)
  try { normalizeSetup({ ...s, dumpId: undefined, image: undefined }, locale); } catch (e) { problems.push({ field: 'setup', message: errMsg(e) }); }
  if (s.kind !== 'none' && s.source !== 'none') {
    if (!githubConnected()) problems.push({ field: 'github', message: m.github });
    else {
      // the branch on its own (one request; a list of all branches stops after 500)
      let branchOk = true;
      try { await assertBaseBranch(s.baseBranch); } catch (e) { branchOk = false; problems.push({ field: 'branch', message: errMsg(e) }); }
      try {
        await checkRepoAccess(s.repo);
        if (branchOk && !(await branchExists(s.repo, s.baseBranch))) problems.push({ field: 'branch', message: m.branch(s.baseBranch, s.repo) });
      } catch (e) { problems.push({ field: 'repo', message: m.repo(errMsg(e)) }); }
    }
  }
  if (s.dumpId) { const d = codeDumpGet(s.dumpId); if (!d?.library || d.status !== 'ready') problems.push({ field: 'dump', message: m.dump }); }
  if (s.image) { const cfg = getSandboxConfig(); try { imageTag(s.image, cfg.image, cfg.template); } catch (e) { problems.push({ field: 'image', message: m.image(errMsg(e)) }); } }
  const known = new Set(getSandboxConfig().envVars.map(v => v.key)), missing = (s.envRefs ?? []).filter(k => !known.has(k));
  if (missing.length) warnings.push(m.envMissing(missing.join(', ')));
  return { problems, warnings };
}

/** A quick start that cannot start as saved: the route answers 422 with the problems, the browser opens the dialog prefilled */
export class QuickStartBrokenError extends Error {
  constructor(readonly lead: string, readonly problems: QuickStartProblem[], readonly quickStart: QuickStartPublic) { super(`${lead} ${problems.map(p => p.message).join(' ')}`); }
}

/** One click in the "Sandbox" menu: checks the quick start, then starts it in this chat like the dialog would (title = its name).
 *  The repository file's commands still wait for a human decision in the setup. */
export async function startQuickStart(id: string, chatId: string, locale: Locale = DEFAULT_LOCALE): Promise<{ task: CodeTask; warnings: string[] }> {
  const q = getQuickStart(id, locale);
  const { problems, warnings } = await checkQuickStart(q, locale);
  if (problems.length) throw new QuickStartBrokenError(M(locale).broken(q.name), problems, q);
  const s = q.setup, kind = s.kind;
  const task = await startSandbox({
    chatId, goal: '', title: q.name, repo: s.repo, baseBranch: s.baseBranch, source: kind === 'none' ? 'none' : 'repo', mode: kind === 'custom' ? 'custom' : s.mode ?? 'auto',
    ...(s.pluginName ? { pluginName: s.pluginName } : {}), ...(s.targetPath ? { targetPath: s.targetPath } : {}), ...(s.commands ? { commands: s.commands } : {}),
    ...(s.env ? { env: s.env } : {}), ...(s.dumpId ? { dumpId: s.dumpId } : {}), ...(s.image ? { image: s.image } : {}), ...(s.previewPath ? { previewPath: s.previewPath } : {}),
    ...(s.notes ? { notes: s.notes } : {}),
  }, locale, { quickStart: q.name });
  const store = load(), row = store.items.find(x => x.id === id);
  if (row) { row.lastUsedAt = now(); save(store); }
  audit(q, 'use', { taskId: task.id, chatId });
  return { task, warnings };
}

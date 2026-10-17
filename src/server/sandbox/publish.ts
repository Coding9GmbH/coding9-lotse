import 'server-only';
// Publishing a task's changes: commit, push to lotse/<slug>-<id> and open (or update) the pull request. Only a human click
// (POST /api/sandbox/tasks/[id]/publish) gets here; the AI can only propose title and description (propose_publish).
// - branch and base come from the task (fixed at creation), never from the request; only refs/heads/lotse/* is written,
//   a re-push uses --force-with-lease on exactly the SHA Lotse pushed last (git.ts)
// - preflight before anything is written: changes exist, paths stay in the repository, no .github/workflows, no secret
//   files, limits on files and size, a secret scan of the added lines (tokens, private keys, every secret Lotse knows)
// - audit "started" before the first write and a result row afterwards, both with the actor; the token never appears
// - idempotent: a retry after a failure or a restart continues (nothing new to commit, push is a no-op, the open PR is reused)
import fs from 'node:fs';
import path from 'node:path';
import type { PrStatus, PublishStep, TaskPr } from '@/lib/protocol';
import { currentActor } from '../actor';
import { auditAdd } from '../db';
import { commitAll, diffAgainstBase, pushBranch, runGit, type GitIdentity } from '../git';
import { checkSummary, createPull, findOpenPull, getPull, githubConnected, updatePull, type Pull } from '../github';
import { log } from '../log';
import { knownSecrets, redact } from '../settings';
import { noteChatEvent } from '../sessions';
import { singleton } from '../state';
import { errMsg } from '../util';
import { TaskConflict } from './jobs';
import { isDenied } from './workspace-fs';
import { markPublishing, mustTask, now, publishRunning, saveTask, taskPaths, turnRunning, type CodeTask } from './tasks';

export const PUBLISH_LIMITS = { files: 300, fileBytes: 5 * 1024 * 1024, totalBytes: 25 * 1024 * 1024, title: 200, body: 20_000 } as const;
export const LOTSE_AUTHOR: GitIdentity = { name: 'Lotse', email: 'lotse@users.noreply.github.com' };
const FOOTER = '\n\n---\n_Erstellt mit Lotse in einer Sandbox (Shopware-Container); Titel und Beschreibung vor dem Veröffentlichen vom Nutzer geprüft._';

class PublishBlocked extends Error { readonly status = 422; }
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

// ---- Preflight ----
/** Secret-looking content: tokens of common services, private keys, URLs with credentials. Plus every secret Lotse stores. */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/, 'privater Schlüssel'],
  [/\b(github_pat_[A-Za-z0-9_]{22,}|gh[pousr]_[A-Za-z0-9]{30,})/, 'GitHub-Token'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/, 'AWS-Zugangsschlüssel'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, 'Anthropic-API-Schlüssel'],
  [/\bsk-(proj-|svcacct-)?[A-Za-z0-9_-]{32,}/, 'OpenAI-API-Schlüssel'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, 'Slack-Token'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google-API-Schlüssel'],
  [/\bSWIA[A-Z0-9]{20,}\b/, 'Shopware-Integrationsschlüssel'],
  [/\bshp(at|ca|pa|ss)_[a-fA-F0-9]{32}\b/, 'Shopify-Token'],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:'"]+:[^\s/@'"]{3,}@[^\s/]+/i, 'Adresse mit Zugangsdaten'],
];
/** What a text contains that must not be published (kind of secret), or null. */
export function findSecret(text: string, known: string[] = knownSecrets()): string | null {
  for (const [re, what] of SECRET_PATTERNS) if (re.test(text)) return what;
  for (const v of known) if (v.length >= 8 && text.includes(v)) return 'ein in Lotse gespeichertes Geheimnis';
  return null;
}

export interface Changed { path: string; status: string }
/** Paths of git's --name-status output (renames/copies: both). */
export function changedPaths(nameStatus: string): Changed[] {
  return nameStatus.split('\n').filter(Boolean).flatMap(line => {
    const [code, ...p] = line.split('\t');
    return p.map(x => ({ path: x, status: code[0] }));
  });
}

/** The reason a set of changed paths must not be published, in plain German, or null. */
export function blockReason(files: Changed[]): string | null {
  if (!files.length) return 'Nichts zu veröffentlichen: keine Änderungen gegenüber dem Basis-Branch.';
  if (files.length > PUBLISH_LIMITS.files) return `Zu viele geänderte Dateien (${files.length}, höchstens ${PUBLISH_LIMITS.files}).`;
  for (const { path: p } of files) {
    if (!p || p.startsWith('/') || p.split('/').includes('..') || p.includes('\\') || /[\x00-\x1f]/.test(p)) return `Ungültiger Pfad „${p.slice(0, 120)}“.`;
    if (/^\.github\/workflows(\/|$)/i.test(p)) return `Änderungen an GitHub-Workflows (${p.slice(0, 120)}) veröffentlicht Lotse nicht – sie liefen mit den Rechten des Repositorys.`;
    if (isDenied(p)) return `„${p.slice(0, 120)}“ ist eine geschützte Datei (.git, Geheimnis oder Schlüssel) und wird nicht veröffentlicht.`;
  }
  return null;
}

/** Secret scan of one file: every line that is new against the base version (removing a leaked key must stay possible). */
export function scanFile(file: string, content: string, baseLines: Set<string>, known: string[] = knownSecrets()): string | null {
  for (const line of content.split('\n')) {
    if (baseLines.has(line)) continue;
    const what = findSecret(line, known);
    if (what) return `Veröffentlichen blockiert: In „${file.slice(0, 120)}“ steht etwas, das wie ein Geheimnis aussieht (${what}). Bitte entfernen und erneut versuchen.`;
  }
  return null;
}

/** Sizes, symlinks and the secret scan on the files as they are on disk (git's own output is redacted, so it cannot be scanned). */
async function checkOnDisk(t: CodeTask, files: Changed[], known: string[]): Promise<string | null> {
  const { worktree, gitDir } = taskPaths(t.id), realRoot = fs.realpathSync(worktree);
  let total = 0;
  for (const f of files) {
    if (f.status === 'D') continue;
    const abs = path.join(worktree, f.path);
    let st: fs.Stats;
    try { st = fs.lstatSync(abs); } catch { continue; } // the old path of a rename
    if (st.isSymbolicLink()) {
      let real = '';
      try { real = fs.realpathSync(abs); } catch { /* dangling */ }
      if (!real || !(real === realRoot || real.startsWith(realRoot + path.sep))) return `„${f.path.slice(0, 120)}“ ist ein Symlink aus dem Repository heraus und wird nicht veröffentlicht.`;
      continue;
    }
    if (!st.isFile()) continue;
    if (st.size > PUBLISH_LIMITS.fileBytes) return `„${f.path.slice(0, 120)}“ ist zu groß (${Math.round(st.size / 1024 / 1024)} MB, höchstens ${PUBLISH_LIMITS.fileBytes / 1024 / 1024} MB je Datei).`;
    total += st.size;
    if (total > PUBLISH_LIMITS.totalBytes) return `Die Änderungen sind zu groß (höchstens ${PUBLISH_LIMITS.totalBytes / 1024 / 1024} MB).`;
    const base = f.status === 'A' ? '' : await runGit(['show', `refs/remotes/origin/${t.baseBranch}:${f.path}`], { cwd: worktree, gitDir }).then(r => r.stdout, () => '');
    const why = scanFile(f.path, fs.readFileSync(abs).toString('latin1'), new Set(base ? Buffer.from(base, 'utf8').toString('latin1').split('\n') : []), known);
    if (why) return why;
  }
  return null;
}

/** Everything that would be published, checked; throws PublishBlocked with the reason. */
export async function preflight(t: CodeTask): Promise<Changed[]> {
  const p = taskPaths(t.id);
  const raw = await diffAgainstBase(p.worktree, p.gitDir, t.baseBranch);
  const files = changedPaths(raw.status);
  const why = blockReason(files) ?? await checkOnDisk(t, files, knownSecrets());
  if (why) throw new PublishBlocked(why);
  return files;
}

// ---- Errors in plain German ----
function germanError(step: PublishStep, e: unknown, t: CodeTask): string {
  const m = redact(errMsg(e));
  if (step === 'push') {
    if (/GH006|GH013|protected branch|rule violations|push declined/i.test(m)) return `Branch-Schutz verhindert den Push auf ${t.branch}: Regel für lotse/* im Repository anpassen.`;
    if (/stale info|fetch first|non-fast-forward|\[rejected\]/i.test(m)) return `Der Branch ${t.branch} wurde auf GitHub verändert. Lotse überschreibt keine fremden Commits – Branch auf GitHub prüfen.`;
    if (/403|denied|not allowed|Permission|Write access/i.test(m)) return `Keine Schreibrechte für ${t.repo}: Der Token braucht Contents + Pull requests: Lesen & Schreiben.`;
    return `Push fehlgeschlagen: ${m}`;
  }
  if (step === 'pr') {
    if (/Anfragelimit/.test(m)) return m;
    if (/\(403\)|Resource not accessible/.test(m)) return `Keine Schreibrechte für Pull Requests in ${t.repo}: Der Token braucht Pull requests: Lesen & Schreiben.`;
    if (/No commits between/i.test(m)) return 'Nichts zu veröffentlichen: Der Branch unterscheidet sich nicht vom Basis-Branch.';
    return `Pull Request nicht angelegt: ${m}`;
  }
  return m;
}

// ---- Publish ----
const coAuthor = (actor: string | null): GitIdentity | undefined => {
  const name = actor?.replace(/[<>\n\r]/g, '').trim().slice(0, 80);
  if (!name) return undefined;
  const local = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'nutzer';
  return { name, email: `${local}@lotse.invalid` }; // a reserved domain: never mistaken for someone's GitHub account
};
const cleanTitle = (s: string) => s.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, PUBLISH_LIMITS.title);
const cleanBody = (s: string) => s.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim().slice(0, PUBLISH_LIMITS.body);

export interface PublishOutcome { task: CodeTask; pr: TaskPr; action: 'created' | 'updated'; files: number }

/** Checks what can be checked synchronously, then runs the publish (registered at once: a second click gets 409). */
export function publishTask(id: string, input: { title: string; body: string }): Promise<PublishOutcome> {
  const t = mustTask(id);
  if (!githubConnected()) throw fail(400, 'GitHub ist nicht verbunden (Einstellungen → Integrationen).');
  if (publishRunning(id)) throw new TaskConflict('Für diese Aufgabe wird gerade veröffentlicht.');
  if (turnRunning(id)) throw new TaskConflict('Die KI arbeitet gerade in dieser Sandbox – warte, bis die Runde fertig ist (oder stoppe sie).');
  if (t.status === 'done') throw new TaskConflict('Die Aufgabe ist abgeschlossen.');
  if (!t.steps.some(s => s.key === 'clone' && s.state === 'done') || !fs.existsSync(taskPaths(id).worktree)) throw new TaskConflict('Das Repository ist noch nicht geklont – erst die Einrichtung abwarten.');
  const title = cleanTitle(input.title), body = cleanBody(input.body);
  if (!title) throw fail(400, 'Titel fehlt.');
  const secret = findSecret(`${title}\n${body}`);
  if (secret) throw new PublishBlocked(`Titel oder Beschreibung enthalten etwas, das wie ein Geheimnis aussieht (${secret}).`);
  return markPublishing(id, run(id, title, body, currentActor(t.chatId)));
}

/** Re-read, change and save the task: the setup, the idle sweeper or a wake-up may have saved it meanwhile. */
function update(id: string, fn: (t: CodeTask) => void): CodeTask { const t = mustTask(id); fn(t); saveTask(t); return t; }

async function run(id: string, title: string, body: string, actor: string | null): Promise<PublishOutcome> {
  const t = mustTask(id), p = taskPaths(id);
  let step: PublishStep = 'check', started = false;
  const at = (s: PublishStep) => { step = s; update(id, x => { x.publish = { state: 'running', step: s, at: now() }; }); };
  const base = { kind: 'code-pr', taskId: t.id, chatId: t.chatId, title: `Pull Request: ${title}`, repo: t.repo, branch: t.branch, base: t.baseBranch };
  try {
    at('check');
    const files = await preflight(t);
    auditAdd({ ...base, decision: 'approved', status: 'started', files: files.length }, actor); // before the first write
    started = true;
    at('commit');
    await commitAll(p.worktree, p.gitDir, `${title}\n\n${body}`.slice(0, 4000), LOTSE_AUTHOR, coAuthor(actor));
    at('push');
    const head = (await runGit(['rev-parse', 'HEAD'], { cwd: p.worktree, gitDir: p.gitDir })).stdout.trim();
    let pushed = mustTask(id).pushedSha;
    if (head !== pushed) {
      const { sha } = await pushBranch({ repo: t.repo, branch: t.branch, worktree: p.worktree, gitDir: p.gitDir, pushedSha: pushed });
      pushed = sha;
      update(id, x => { x.pushedSha = sha; }); // at once: a retry after a later failure pushes with a lease on this state
    }
    at('pr');
    const text = `${body}${FOOTER}`;
    let pr: Pull | null = await findOpenPull(t.repo, t.branch), action: 'created' | 'updated' = 'updated';
    if (pr) pr = await updatePull(t.repo, pr.number, { title, body: text });
    else {
      try { pr = await createPull(t.repo, { title, body: text, head: t.branch, base: t.baseBranch }); action = 'created'; }
      catch (e) { // opened meanwhile (a retry after a lost response): reuse it
        if (!/already exists/i.test(errMsg(e))) throw e;
        pr = await findOpenPull(t.repo, t.branch);
        if (!pr) throw e;
        pr = await updatePull(t.repo, pr.number, { title, body: text });
      }
    }
    const done: TaskPr = { number: pr.number, url: pr.url, title: pr.title || title };
    const task = update(id, x => { Object.assign(x, { prNumber: done.number, prUrl: done.url, prTitle: done.title, publish: null } satisfies Partial<CodeTask>); });
    forgetPrStatus(id);
    const paths = files.map(f => f.path);
    auditAdd({ ...base, decision: 'approved', status: 'applied', action, prUrl: done.url, prNumber: done.number, sha: pushed, files: paths.slice(0, 50), ...(paths.length > 50 ? { moreFiles: paths.length - 50 } : {}) }, actor);
    if (t.chatId) noteChatEvent(t.chatId, { t: 'pr', taskId: id, ...done, action, files: paths.length });
    log.info(action === 'created' ? 'Pull Request angelegt' : 'Pull Request aktualisiert', { task: id, repo: t.repo, branch: t.branch, pr: done.number });
    return { task, pr: done, action, files: paths.length };
  } catch (e) {
    const blocked = e instanceof PublishBlocked, msg = blocked ? e.message : germanError(step, e, t);
    update(id, x => { x.publish = { state: 'failed', step, error: msg.slice(0, 500), at: now() }; });
    if (started) auditAdd({ ...base, decision: 'approved', status: 'failed', step, error: msg.slice(0, 300) }, actor);
    else if (blocked) auditAdd({ ...base, decision: 'rejected', reason: msg.slice(0, 300) }, actor);
    log.warn('Veröffentlichen fehlgeschlagen', { task: id, step, error: msg });
    throw blocked ? e : Object.assign(new Error(msg), { status: step === 'check' ? 500 : 502 });
  }
}

// ---- Live state of the pull request (GitHub), cached briefly ----
const PR_CACHE_MS = 45_000;
const prCache = () => singleton<Map<string, { at: number; data: PrStatus }>>('sandboxPrStatus', () => new Map());
export const forgetPrStatus = (id: string) => { prCache().delete(id); };
export async function prStatus(t: CodeTask, nowMs = Date.now()): Promise<PrStatus | null> {
  if (!t.prNumber) return null;
  const hit = prCache().get(t.id);
  if (hit && nowMs - hit.at < PR_CACHE_MS) return hit.data;
  const pr = await getPull(t.repo, t.prNumber);
  const checks = pr.headSha ? await checkSummary(t.repo, pr.headSha).catch(() => null) : null; // checks need their own permission
  const data = { number: pr.number, url: pr.url, title: pr.title, state: pr.state, draft: pr.draft, checks, fetchedAt: new Date(nowMs).toISOString() };
  prCache().set(t.id, { at: nowMs, data });
  return data;
}

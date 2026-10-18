import 'server-only';
// Publishing a task's changes: push the local commits (the AI's git_commit) to lotse/<slug>-<id> – plus one last commit only for
// what is not committed yet – and open (or update) the pull request. Only a human click (POST /api/sandbox/tasks/[id]/publish)
// gets here; the AI can only commit locally and propose title and description (propose_publish).
// - branch and base come from the task (fixed at creation), never from the request; only refs/heads/lotse/* is written,
//   a re-push uses --force-with-lease on exactly the SHA Lotse pushed last (git.ts)
// - preflight before anything is written: changes exist, paths stay in the repository, no .github/workflows or
//   .github/actions (nor action.yml anywhere), no secret files, limits on files and size, a secret scan of the added lines (tokens, private keys,
//   every plausible secret Lotse stores, as a token of its own – secret-values.ts); a finding names file and line, and the ones that
//   may be false positives (stored values, URLs with credentials) can be published anyway by an explicit, audited click of the user
// - audit "started" before the first write and a result row afterwards, both with the actor; the token never appears
// - no screenshots of its own: the body only mentions the ones the user took by hand (screenshots.ts)
// - idempotent: a retry after a failure or a restart continues (nothing new to commit, push is a no-op, the open PR is reused)
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PrStatus, PublishStep, SecretFinding, TaskPr } from '@/lib/protocol';
import { currentActor } from '../actor';
import { auditAdd } from '../db';
import { DEFAULT_LOCALE, messages, type Locale } from '@/lib/i18n';
import { GitError, commitAll, diffAgainstBase, pushBranch, readBaseBlob, runGit, unpublishedMessages, type GitIdentity, type StagedReader } from '../git';
import { checkSummary, createPull, findOpenPull, getPull, githubConnected, updatePull, type Pull } from '../github';
import { log } from '../log';
import { redact, scanSecrets } from '../settings';
import { findToken, plausibleSecret, weakCredentialIn } from '../secret-values';
import { noteChatEvent } from '../sessions';
import { singleton } from '../state';
import { errMsg } from '../util';
import { setupBusy, TaskConflict } from './jobs';
import { shotNote } from './screenshots';
import { isDenied } from './workspace-fs';
import { markPublishing, mustTask, now, publishRunning, saveTask, taskPaths, turnRunning, type CodeTask } from './tasks';

export const PUBLISH_LIMITS = { files: 300, fileBytes: 5 * 1024 * 1024, totalBytes: 25 * 1024 * 1024, title: 200, body: 20_000 } as const;
export const LOTSE_AUTHOR: GitIdentity = { name: 'Lotse', email: 'lotse@users.noreply.github.com' };
const FOOTER = '\n\n---\n_Erstellt mit Lotse in einer Sandbox (Shopware-Container); Titel und Beschreibung vor dem Veröffentlichen vom Nutzer geprüft._';

class PublishBlocked extends Error {
  readonly status = 422;
  constructor(message: string, readonly findings?: SecretFinding[]) { super(message); }
}
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

// ---- Preflight ----
/** Secret-looking content: tokens of common services, private keys, URLs with credentials (overridable: may be a placeholder). Plus every secret Lotse stores. */
const SECRET_PATTERNS: [RegExp, string, boolean][] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/, 'privater Schlüssel', false],
  [/\b(github_pat_[A-Za-z0-9_]{22,}|gh[pousr]_[A-Za-z0-9]{30,})/, 'GitHub-Token', false],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/, 'AWS-Zugangsschlüssel', false],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, 'Anthropic-API-Schlüssel', false],
  [/\bsk-(proj-|svcacct-)?[A-Za-z0-9_-]{32,}/, 'OpenAI-API-Schlüssel', false],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, 'Slack-Token', false],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google-API-Schlüssel', false],
  [/\bSWIA[A-Z0-9]{20,}\b/, 'Shopware-Integrationsschlüssel', false],
  [/\bshp(at|ca|pa|ss)_[a-fA-F0-9]{32}\b/, 'Shopify-Token', false],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:'"]+:[^\s/@'"]{3,}@[^\s/]+/i, 'Adresse mit Zugangsdaten', true],
];
export const STORED_SECRET = 'ein in Lotse gespeichertes Geheimnis';
/**
 * What a text contains that must not be published (kind of secret, and whether the user may publish it anyway), or null.
 * `known`: the stored secrets (scanSecrets()). Plausible ones count as a token of their own anywhere; weak ones ("sommer2024",
 * "shopware") only as the value of a credential key ("password => 'sommer2024'", "DB_PW=…") – "shopware/core" in every composer.json
 * stays clean.
 */
export function secretIn(text: string, known: string[] = scanSecrets()): { what: string; overridable: boolean } | null {
  for (const [re, what, overridable] of SECRET_PATTERNS) if (re.test(text)) return { what, overridable };
  // files are read as latin1 (byte for byte): a non-ASCII secret appears there as its UTF-8 bytes
  for (const v of known) {
    const variants = [v, Buffer.from(v, 'utf8').toString('latin1')];
    const strong: boolean = plausibleSecret(v);
    const hit = strong ? variants.some(x => findToken(text, x) !== -1) : v.length > 3 && variants.some(x => weakCredentialIn(text, x));
    if (hit) return { what: STORED_SECRET, overridable: true };
  }
  return null;
}
/** What a text contains that must not be published (kind of secret), or null. */
export const findSecret = (text: string, known: string[] = scanSecrets()): string | null => secretIn(text, known)?.what ?? null;

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
    if (/^\.github\/(workflows|actions)(\/|$)/i.test(p) || /(^|\/)action\.ya?ml$/i.test(p)) return `Änderungen an GitHub-Workflows oder -Actions (${p.slice(0, 120)}) veröffentlicht Lotse nicht – sie liefen mit den Rechten des Repositorys.`;
    if (isDenied(p)) return `„${p.slice(0, 120)}“ ist eine geschützte Datei (.git, Geheimnis oder Schlüssel) und wird nicht veröffentlicht.`;
  }
  return null;
}

/** A finding's id: file and the line's content (not its number – an approval stays valid while other lines move, and ends when the line changes). */
const findingId = (file: string, line: string) => createHash('sha256').update(`${file}\n${line}`).digest('hex').slice(0, 16);
const FINDINGS_MAX = 20;

/**
 * Secret scan of one file: every line that is new against the base version (removing a leaked key must stay possible). A stored
 * value that the base version of the file already contains is no new leak (e.g. a word that is also someone's password).
 */
export function scanFindings(file: string, content: string, baseLines: Set<string>, known: string[] = scanSecrets(), baseText = ''): SecretFinding[] {
  const fresh = baseText ? known.filter(v => !baseText.includes(v) && !baseText.includes(Buffer.from(v, 'utf8').toString('latin1'))) : known;
  const out: SecretFinding[] = [];
  content.split('\n').forEach((line, i) => {
    if (out.length >= FINDINGS_MAX || baseLines.has(line)) return;
    const hit = secretIn(line, fresh);
    if (hit) out.push({ id: findingId(file, line), file: file.slice(0, 300), line: i + 1, kind: hit.what, overridable: hit.overridable });
  });
  return out;
}
/** The blocking message for findings (the first one named, the rest counted). */
export function findingsText(found: SecretFinding[]): string {
  const [f] = found, more = found.length - 1;
  return `Veröffentlichen blockiert: In „${f.file.slice(0, 120)}“ (Zeile ${f.line}) steht etwas, das wie ein Geheimnis aussieht (${f.kind})${more ? ` – dazu ${more === 1 ? 'eine weitere Stelle' : `${more} weitere Stellen`}` : ''}. Bitte entfernen und erneut versuchen${found.every(x => x.overridable) ? ' – oder nach Prüfung „Trotzdem veröffentlichen“' : ''}.`;
}
/** Secret scan of one file as a message (first finding), or null. */
export function scanFile(file: string, content: string, baseLines: Set<string>, known: string[] = scanSecrets(), baseText = ''): string | null {
  const found = scanFindings(file, content, baseLines, known, baseText);
  return found.length ? findingsText(found) : null;
}

/** Sizes, symlinks and the secret scan on the files as they are on disk (git's own output is redacted, so it cannot be scanned) –
 *  or, with `read` (git_commit), on the staged bytes the commit will hold. */
async function checkOnDisk(t: CodeTask, files: Changed[], known: string[], head?: string, read?: StagedReader): Promise<{ why: string | null; findings: SecretFinding[] }> {
  const { worktree, gitDir } = taskPaths(t.id), realRoot = fs.realpathSync(worktree);
  const findings: SecretFinding[] = [];
  let total = 0;
  const stop = (why: string) => ({ why, findings: [] });
  for (const f of files) {
    if (f.status === 'D') continue;
    const abs = path.join(worktree, f.path);
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(abs); } catch { if (!read) continue; } // the old path of a rename (staged: gone from disk since, the blob counts)
    if (st?.isSymbolicLink()) {
      let real = '';
      try { real = fs.realpathSync(abs); } catch { /* dangling */ }
      if (!real || !(real === realRoot || real.startsWith(realRoot + path.sep))) return stop(`„${f.path.slice(0, 120)}“ ist ein Symlink aus dem Repository heraus und wird nicht veröffentlicht.`);
      if (!read) continue;
    }
    if (st && !st.isFile() && !read) continue;
    const tooBig = (n: number) => `„${f.path.slice(0, 120)}“ ist zu groß (${Math.round(n / 1024 / 1024)} MB, höchstens ${PUBLISH_LIMITS.fileBytes / 1024 / 1024} MB je Datei).`;
    if (st && !read && st.size > PUBLISH_LIMITS.fileBytes) return stop(tooBig(st.size)); // before reading it
    const data = read ? await read(f.path) : fs.readFileSync(abs);
    if (!data) return stop(`„${f.path.slice(0, 120)}“ konnte nicht geprüft werden (zu groß oder nicht lesbar).`);
    if (data.length > PUBLISH_LIMITS.fileBytes) return stop(tooBig(data.length));
    total += data.length;
    if (total > PUBLISH_LIMITS.totalBytes) return stop(`Die Änderungen sind zu groß (höchstens ${PUBLISH_LIMITS.totalBytes / 1024 / 1024} MB).`);
    if (findings.length >= FINDINGS_MAX) continue;
    const base = await readBaseBlob(worktree, gitDir, t.baseBranch, f.path); // unredacted: same bytes as on disk
    const baseText = base ? base.toString('latin1') : '';
    // lines Lotse already pushed (a finding the user published anyway) do not block the next update again
    const pushed = t.pushedSha ? await readBaseBlob(worktree, gitDir, t.baseBranch, f.path, t.pushedSha) : null;
    // a commit check (git_commit): lines already committed were checked when they were committed
    const committed = head && head !== t.pushedSha ? await readBaseBlob(worktree, gitDir, t.baseBranch, f.path, head) : null;
    const lines = new Set([...(baseText ? baseText.split('\n') : []), ...(pushed ? pushed.toString('latin1').split('\n') : []), ...(committed ? committed.toString('latin1').split('\n') : [])]);
    findings.push(...scanFindings(f.path, data.toString('latin1'), lines, known, baseText));
  }
  return { why: null, findings: findings.slice(0, FINDINGS_MAX) };
}

/**
 * Everything that would be published, checked; throws PublishBlocked with the reason (and the secret findings, if that is the reason).
 * `allow`: ids of findings the user publishes anyway ("Trotzdem veröffentlichen"); only overridable ones count, returned as `overridden`.
 */
export async function preflight(t: CodeTask, allow: readonly string[] = []): Promise<{ files: Changed[]; overridden: SecretFinding[] }> {
  const p = taskPaths(t.id);
  const raw = await diffAgainstBase(p.worktree, p.gitDir, t.baseBranch);
  const files = changedPaths(raw.status);
  const early = blockReason(files);
  if (early) throw new PublishBlocked(early);
  const { why, findings } = await checkOnDisk(t, files, scanSecrets());
  if (why) throw new PublishBlocked(why);
  // the local commits are pushed as they are: a secret in one of their messages would reach GitHub (git_commit refuses them already)
  const inMessage = findSecret(await unpublishedMessages(p.worktree, p.gitDir, t.baseBranch, t.pushedSha));
  if (inMessage) throw new PublishBlocked(`Veröffentlichen blockiert: Eine lokale Commit-Nachricht enthält etwas, das wie ein Geheimnis aussieht (${inMessage}). Lotse schreibt die Historie nicht um – diese Commits werden nicht veröffentlicht.`);
  const ok = new Set(allow), open = findings.filter(f => !(f.overridable && ok.has(f.id)));
  if (open.length) throw new PublishBlocked(findingsText(open), open);
  return { files, overridden: findings };
}

/**
 * Before the AI's local commit (git_commit): the same rules as publishing for exactly the files to be committed (with `read`: their staged bytes) – every commit is
 * pushed later, and history is never rewritten, so a secret must not get into a commit at all. Unlike publishing nothing can be
 * overridden here (a possible false positive stays uncommitted; the user decides at publishing). Returns the reason, or null.
 */
export async function commitCheck(t: CodeTask, files: Changed[], head: string, read?: StagedReader): Promise<string | null> {
  const early = blockReason(files);
  if (early) return early;
  const { why, findings } = await checkOnDisk(t, files.filter(f => f.status !== 'D'), scanSecrets(), head, read);
  if (why) return why;
  if (!findings.length) return null;
  const [f] = findings;
  return `Nicht committet: In „${f.file.slice(0, 120)}“ (Zeile ${f.line}) steht etwas, das wie ein Geheimnis aussieht (${f.kind})${findings.length > 1 ? ` – dazu ${findings.length - 1} weitere Stelle(n)` : ''}. Entfernen und erneut committen; ist es sicher kein Geheimnis, die Datei nicht committen – der Nutzer entscheidet beim Veröffentlichen.`;
}

// ---- Errors in plain language ----
/** First line that says why: a remote message ("remote: …"), the reason of a refused ref ("! … [remote rejected] (why)"), or git's error line. */
function firstReason(detail: string): string {
  const lines = detail.split('\n').map(l => l.trim()).filter(Boolean);
  // GitHub's remote lines: progress, ruler, Trace id, "See https://…" and bare links are noise; the line with a GHxxx code carries the reason
  const remote = lines.map(l => (/^remote:\s*(.*)$/i.exec(l)?.[1].trim() ?? '').replace(/^error:\s*/i, ''))
    .filter(l => l && !/^[-=*—_\s]+$/.test(l) && !/^(Trace:|See https?:|https?:\/\/\S+$|Resolving deltas|Counting objects|Compressing objects|Total \d)/i.test(l));
  const secret = remote.find(l => /cannot contain secrets/i.test(l));
  const coded = remote.find(l => /^GH\d{3}:/.test(l));
  if (secret || coded || remote[0]) return (secret ?? coded ?? remote[0]).replace(/^-\s*/, '');
  const refused = lines.map(l => /\[(?:remote )?rejected\][^(]*\(([^)]+)\)/.exec(l)?.[1]).find(Boolean);
  if (refused) return refused;
  const err = lines.find(l => /^(fatal|error):/i.test(l)) ?? lines[0] ?? '';
  return err.replace(/^(fatal|error):\s*/i, '');
}
/**
 * Text of a failed push, in the user's language. Only a real 403 of GitHub ("The requested URL returned error: 403",
 * "Permission to … denied to") becomes the token hint; branch protection and a branch moved on GitHub have their own text;
 * every other refusal shows the server's first line ("Push abgelehnt: …"). git's full report follows after a line break (the UI folds it).
 */
export function pushErrorText(detail: string, t: Pick<CodeTask, 'repo' | 'branch'>, locale: Locale = DEFAULT_LOCALE): string {
  const L = messages(locale).server, d = redact(detail).trim();
  const reason = firstReason(d).slice(0, 200);
  // GH006 = protected branch, GH013 = repository rules; GH013 for a secret found by push protection is a refusal with its own reason
  const summary = /\bGH006\b|\bGH013\b|protected branch|rule violations/i.test(d) && !/push protection|cannot contain secrets/i.test(d) ? L.pushProtected(t.branch)
    : /stale info|fetch first|non-fast-forward|(?<!remote )\[rejected\]/i.test(d) ? L.pushMoved(t.branch)
      : /The requested URL returned error: 403|Permission to \S+ denied to|Write access to repository not granted/i.test(d) ? L.pushNoPermission(t.repo)
        : /^remote:|\[remote rejected\]|pre-receive hook declined|push declined/im.test(d) ? L.pushRejected(reason)
          : L.pushFailed(reason || '–');
  return d && d !== reason ? `${summary}\n${d}` : summary;
}

function errorText(step: PublishStep, e: unknown, t: CodeTask, locale: Locale): string {
  const m = redact(errMsg(e)), L = messages(locale).server;
  if (step === 'push') return pushErrorText(e instanceof GitError && e.detail ? e.detail : m, t, locale);
  if (step === 'pr') {
    if (/Anfragelimit/.test(m)) return m;
    if (/\(403\)|Resource not accessible/.test(m)) return L.prNoPermission(t.repo);
    if (/No commits between/i.test(m)) return L.prNothing;
    return L.prFailed(m);
  }
  return m;
}

// ---- Publish ----
/** The person behind a commit as co-author (author is always Lotse): publishing and the AI's git_commit. */
export const coAuthor = (actor: string | null): GitIdentity | undefined => {
  const name = actor?.replace(/[<>\n\r]/g, '').trim().slice(0, 80);
  if (!name) return undefined;
  const local = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'nutzer';
  return { name, email: `${local}@lotse.invalid` }; // a reserved domain: never mistaken for someone's GitHub account
};
const cleanTitle = (s: string) => s.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, PUBLISH_LIMITS.title);
const cleanBody = (s: string) => s.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim().slice(0, PUBLISH_LIMITS.body);

export interface PublishOutcome { task: CodeTask; pr: TaskPr; action: 'created' | 'updated'; files: number }

/** Checks what can be checked synchronously, then runs the publish (registered at once: a second click gets 409). */
export function publishTask(id: string, input: { title: string; body: string; allowFindings?: string[] }, locale: Locale = DEFAULT_LOCALE): Promise<PublishOutcome> {
  const t = mustTask(id);
  if (!githubConnected()) throw fail(400, 'GitHub ist nicht verbunden (Einstellungen → Integrationen).');
  if (publishRunning(id)) throw new TaskConflict(messages(locale).server.publishRunning);
  if (setupBusy(id)) throw new TaskConflict(messages(locale).server.publishSetupBusy);
  if (turnRunning(id)) throw new TaskConflict('Die KI arbeitet gerade in dieser Sandbox – warte, bis die Runde fertig ist (oder stoppe sie).');
  if (t.status === 'done') throw new TaskConflict(messages(locale).server.publishTaskDone);
  if (!t.steps.some(s => s.key === 'clone' && s.state === 'done') || !fs.existsSync(taskPaths(id).worktree)) throw new TaskConflict('Das Repository ist noch nicht geklont – erst die Einrichtung abwarten.');
  const title = cleanTitle(input.title), body = cleanBody(input.body);
  if (!title) throw fail(400, 'Titel fehlt.');
  const secret = findSecret(`${title}\n${body}`);
  if (secret) throw new PublishBlocked(`Titel oder Beschreibung enthalten etwas, das wie ein Geheimnis aussieht (${secret}).`);
  return markPublishing(id, run(id, title, body, currentActor(t.chatId), locale, input.allowFindings ?? []));
}

/** Re-read, change and save the task: the setup, the idle sweeper or a wake-up may have saved it meanwhile. */
function update(id: string, fn: (t: CodeTask) => void): CodeTask { const t = mustTask(id); fn(t); saveTask(t); return t; }

async function run(id: string, title: string, body: string, actor: string | null, locale: Locale, allow: readonly string[]): Promise<PublishOutcome> {
  const t = mustTask(id), p = taskPaths(id);
  let step: PublishStep = 'check', started = false;
  const at = (s: PublishStep) => { step = s; update(id, x => { x.publish = { state: 'running', step: s, at: now() }; }); };
  const base = { kind: 'code-pr', taskId: t.id, chatId: t.chatId, title: `Pull Request: ${title}`, repo: t.repo, branch: t.branch, base: t.baseBranch };
  try {
    at('check');
    const { files, overridden } = await preflight(t, allow);
    // published anyway after the user's explicit click: where and what kind, never the value
    const override = overridden.length ? { secretOverride: overridden.map(f => ({ file: f.file, line: f.line, kind: f.kind })) } : {};
    auditAdd({ ...base, decision: 'approved', status: 'started', files: files.length, ...override }, actor); // before the first write
    if (overridden.length) log.warn('Veröffentlichen trotz Geheimnis-Fund freigegeben', { task: id, findings: overridden.map(f => `${f.file}:${f.line}`) });
    started = true;
    at('commit'); // the AI's commits are pushed as they are; only what is not committed yet becomes one last commit
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
    const text = `${body}${shotNote(mustTask(id))}${FOOTER}`;
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
    const blocked = e instanceof PublishBlocked, msg = blocked ? e.message : errorText(step, e, t, locale);
    const findings = blocked && e.findings?.length ? { findings: e.findings } : {};
    update(id, x => { x.publish = { state: 'failed', step, error: msg.slice(0, 2000), at: now(), ...findings }; });
    if (started) auditAdd({ ...base, decision: 'approved', status: 'failed', step, error: msg.split('\n')[0].slice(0, 300) }, actor);
    else if (blocked) auditAdd({ ...base, decision: 'rejected', reason: msg.slice(0, 300) }, actor);
    log.warn('Veröffentlichen fehlgeschlagen', { task: id, step, error: msg });
    throw blocked ? e : Object.assign(new Error(msg.slice(0, 2000)), { status: step === 'check' ? 500 : 502 });
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

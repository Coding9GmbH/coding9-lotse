import 'server-only';
// MCP tools of a chat with an attached sandbox (Sandbox Coding), the same for Claude (in-process) and Codex (over HTTP).
// Files are read and edited with the agent's own tools (Claude: Read/Edit/Write/Glob/Grep, see native-tools.ts; Codex: its patches),
// confined to the task's worktree. Here only what those do not cover: sandbox_bash (any shell command INSIDE the task container,
// never on the host), delete_file, git_diff, git_commit (a local commit in the worktree, like Claude Code does it), the task's own
// storefront, the environment, questions, pull_from_container (files made inside the container taken into the worktree, container-pull.ts),
// the PR proposal and request_internet (asks the human; only the click attaches the
// container to the internet, internet.ts).
// Codex has no file reading of its own without a shell, so it also gets list_files/read_file/search_files.
// Nothing pushes, switches branches, rewrites history, calls GitHub or controls Docker beyond the container exec: git_commit only adds
// one commit on top of HEAD through git.ts, after the same checks publishing makes (paths, workflows, secrets). Cheap to build.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { ChatEvent } from '@/lib/protocol';
import { currentActor } from '../actor';
import { accessAdd } from '../db';
import { COMMIT_LIMITS, assertCommitPath, commitChanges, pendingChanges } from '../git';
import { decodeEntities } from '../html-sanitize';
import { redact } from '../settings';
import { fail, guard, ok, type AnyTool, type ToolResult } from '../tool-kit';
import type { ApprovalReply, Question } from '../sessions';
import { takeOver } from './container-pull';
import { taskDiff } from './diff';
import { sandboxPublic } from './env';
import { grantInternet, internetBlocked, noteInternetDenied, noteInternetFailed } from './internet';
import { ensureAwake, touchTask, withTaskLock } from './jobs';
import { fetchUpstream, sandboxUpstream } from './preview';
import { relOf } from './native-tools';
import { LOTSE_AUTHOR, coAuthor, commitCheck, findSecret } from './publish';
import { getRunner } from './runner';
import { notePending, projectRels, syncTaskAll, syncTaskPaths } from './task-sync';
import { getTemplate } from './templates';
import { mustTask, publishRunning, settleNewPlugin, taskPaths, type CodeTask } from './tasks';
import { deleteText, listFiles, readText, searchFiles, type Change } from './workspace-fs';

/** MCP tools of every sandbox chat */
export const SANDBOX_TOOL_NAMES = ['sandbox_bash', 'pull_from_container', 'delete_file', 'git_diff', 'git_commit', 'read_sandbox_page', 'get_environment', 'ask_user', 'request_internet', 'propose_publish', 'propose_zip'] as const;
/** Codex only: reading the worktree (Claude reads with its own Read/Glob/Grep) */
export const CODEX_READ_TOOL_NAMES = ['list_files', 'read_file', 'search_files'] as const;
export const sandboxToolNames = (provider: 'claude' | 'codex'): string[] => (provider === 'codex' ? [...CODEX_READ_TOOL_NAMES, ...SANDBOX_TOOL_NAMES] : [...SANDBOX_TOOL_NAMES]);
/** Output of sandbox_bash for the AI (end of the output, redacted) */
export const COMMAND_OUTPUT = 12 * 1024;
export const BASH_TIMEOUT = { def: 120, max: 600 } as const;
const DIFF_FOR_AI = 30 * 1024, PAGE_TEXT = 12 * 1024, PAGE_HTML = 30 * 1024;
/** After these the storefront looks different: the preview reloads */
const RELOADS = /\b(theme:(compile|refresh|change)|cache:(clear|pool:clear)|assets:install|plugin:(install|activate|deactivate|update|refresh|uninstall))\b/;

/** What the tools need from the chat session. */
export interface SandboxToolHost {
  id: string;
  taskId: string | null;
  emit: (ev: ChatEvent) => void;
  askUser: (q: Question) => Promise<string>;
  /** open decisions of the chat (request_internet waits here for the click on its card, like a change set) */
  approvals: Map<string, (r: ApprovalReply) => void>;
  abort: AbortController | null;
}

export const tail = (text: string, max: number) => (Buffer.byteLength(text) > max ? `…${Buffer.from(text).subarray(-max).toString('utf8').replace(/^�+/, '')}` : text);

/** Visible text of an HTML page: title + text without scripts, styles and tags. */
export function pageText(html: string): { title: string; text: string } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  const body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\/?(p|div|section|article|header|footer|nav|main|aside|h[1-6]|li|ul|ol|tr|table|br|form|button|a|label|option)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(body).split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
  return { title, text };
}

/** Mirror changed worktree files into the running container (under the task lock); a paused one gets everything when it wakes.
 *  Returns a short note for the AI. Shared by delete_file, Claude's native Edit/Write and Codex' patches. */
export async function syncChanged(taskId: string, rels: string[]): Promise<string> {
  return withTaskLock(taskId, async () => {
    const t = mustTask(taskId);
    if (!t.containerId || !t.containerRunning || !t.layout) { notePending(taskId, projectRels(t, rels)); return ' (Container pausiert: wird beim Fortsetzen übertragen)'; }
    const { note } = await syncTaskPaths(t, rels);
    return ` und in den Container übertragen${note}`;
  }).catch(e => ` – Übertragung in den Container fehlgeschlagen: ${redact(e instanceof Error ? e.message : e).slice(0, 300)}`);
}

/** Text for the command card: one line, redacted, at most 300 characters. */
const cardText = (cmd: string) => { const one = redact(cmd).replace(/\s*\n\s*/g, ' ⏎ ').trim(); return one.length > 300 ? `${one.slice(0, 299)}…` : one; };

export function sandboxTools(host: SandboxToolHost, provider: 'claude' | 'codex' = 'claude'): AnyTool[] {
  const taskId = host.taskId ?? '';
  const task = (): CodeTask => mustTask(taskId);
  const worktree = () => taskPaths(taskId).worktree;
  const log = (op: string, n = 1, denied?: string) => { try { accessAdd({ chat: host.id, op, entity: `repo:${task().repo}`, n, denied: denied ?? null }); } catch { /* log only */ } };
  /** Every call counts as activity (the idle sweeper keeps the container); refusals are logged as denied. */
  const act = <A>(op: string, fn: (a: A) => Promise<ToolResult>) => guard(async (a: A) => {
    touchTask(taskId);
    try { const r = await fn(a); log(op); return r; } catch (e) { log(op, 0, e instanceof Error ? e.message.slice(0, 200) : 'Fehler'); throw e; }
  });
  const changed = async (c: Change) => {
    const note = await syncChanged(taskId, [c.path]);
    host.emit({ t: 'file_change', path: c.path, kind: c.kind, added: c.added, removed: c.removed });
    return ok(`${c.path}: gelöscht (−${c.removed})${note}.`);
  };

  const reads = (provider !== 'codex' ? [] : [
    tool('list_files', 'Listet Dateien und Ordner im Repository der Aufgabe (relativ zur Wurzel, Ordner mit „/“). .git und geheime Dateien sind ausgeblendet; vendor/ und node_modules/ nur, wenn ausdrücklich angefragt.',
      { path: z.string().max(500).optional().describe('Ordner relativ zur Repository-Wurzel, leer = Wurzel'), depth: z.number().int().min(1).max(6).optional().describe('Tiefe, Standard 3') },
      act('list_files', async ({ path, depth }) => {
        const r = listFiles(worktree(), path ?? '', depth ?? 3);
        return ok(`${r.entries.map(e => (e.type === 'file' ? `${e.path} (${e.size} B)` : e.type === 'link' ? `${e.path} → (Symlink)` : e.path)).join('\n') || '(leer)'}${r.truncated ? '\n… (gekürzt, tieferen Ordner angeben)' : ''}`);
      })),

    tool('read_file', 'Liest eine Textdatei des Repositorys mit Zeilennummern (höchstens 256 KB). Optional nur die Zeilen from_line bis to_line.',
      { path: z.string().min(1).max(500), from_line: z.number().int().min(1).optional(), to_line: z.number().int().min(1).optional() },
      act('read_file', async ({ path, from_line, to_line }) => {
        const r = readText(worktree(), path, { from: from_line, to: to_line });
        return ok(`${r.path} (Zeilen ${r.from}–${r.to} von ${r.lines})\n${redact(r.text)}`);
      })),

    tool('search_files', 'Sucht per regulärem Ausdruck (JavaScript-Syntax) in den Textdateien des Repositorys. Liefert „pfad:zeile: text“, höchstens 200 Treffer.',
      { pattern: z.string().min(1).max(500), path: z.string().max(500).optional().describe('Ordner, leer = ganzes Repository'), glob: z.string().max(200).optional().describe('z. B. *.twig oder src/Resources/**/*.scss'), ignore_case: z.boolean().optional() },
      act('search_files', async ({ pattern, path, glob, ignore_case }) => {
        const r = searchFiles(worktree(), pattern, { dir: path, glob, ignoreCase: ignore_case });
        return ok(`${redact(r.hits.join('\n')) || 'Keine Treffer.'}${r.truncated ? '\n… (gekürzt: Suche eingrenzen)' : ''}`);
      })),
  ]) as AnyTool[];

  return [
    ...reads,
    tool('sandbox_bash', `Führt einen Shell-Befehl IM Container der Aufgabe aus (bash -lc, als www-data in /var/www/html – bei einem eigenen Setup im Zielordner; der Container ist ein Wegwerf-Shopware, normalerweise ohne Internet; braucht ein Befehl Internet, erst request_internet). Vorher wird übertragen, was sich im Repository seit dem letzten Übertragen geändert hat (auch außerhalb der Werkzeuge) – sonst nichts: Was im Container geändert wurde (hier, in der Konsole des Nutzers), bleibt dort, bis es mit pull_from_container übernommen oder durch eine Änderung derselben Datei im Repository überschrieben wird; der Container wird dabei nicht auf den Stand des Repositorys zurückgesetzt. Für bin/console (z. B. theme:compile, cache:clear, plugin:refresh), Logs (var/log), mysql -uroot -proot -h127.0.0.1 shopware, curl -H 'Host: localhost' http://127.0.0.1/…, php -l usw. Nach theme:compile/cache:clear lädt die Vorschau neu; zeigt sie nach cache:clear noch den alten Stand, hält ihn der Template- bzw. HTTP-Cache fest – dann bin/console cache:pool:clear --all. Dateien des Repositorys änderst du mit den Datei-Werkzeugen, nicht hier. Erzeugt ein Befehl Dateien, die ins Repository gehören (bin/console plugin:create, composer require in einem Plugin, eine generierte Migration), danach pull_from_container. Zeitlimit Standard ${BASH_TIMEOUT.def} s, höchstens ${BASH_TIMEOUT.max} s; die Ausgabe wird gekürzt (Ende) und geschwärzt.`,
      { command: z.string().min(1).max(10_000).describe('Befehlszeile für bash -lc'), timeout_sec: z.number().int().min(1).max(BASH_TIMEOUT.max).optional().describe(`Zeitlimit in Sekunden (Standard ${BASH_TIMEOUT.def})`) },
      act('sandbox_bash', async ({ command, timeout_sec }) => {
        if (command.includes('\0')) return fail('Ungültiger Befehl.');
        if (!task().layout) return fail('Die Einrichtung ist noch nicht fertig.');
        settleNewPlugin(task()); // a new plugin with composer.json and class is an ordinary plugin from now on
        await ensureAwake(taskId); // paused meanwhile (idle, button): start it again, no new setup
        const tpl = getTemplate(task().template);
        const id = `cmd_${crypto.randomBytes(6).toString('hex')}`, t0 = Date.now(), shown = cardText(command);
        host.emit({ t: 'command', id, command: shown, status: 'running' });
        let res: { exitCode: number; output: string; truncated?: boolean };
        try {
          res = await withTaskLock(taskId, async () => {
            const fresh = task();
            if (!fresh.containerId || !fresh.containerRunning || !fresh.layout) throw new Error('Der Container läuft nicht.');
            await syncTaskAll(fresh, host.abort?.signal, { ifChanged: true });
            // an own setup: in its target folder (no Shopware root assumed)
            const workdir = fresh.layout.kind === 'custom' && fresh.layout.targetPath ? fresh.layout.targetPath : tpl.workdir;
            return getRunner().exec(fresh.containerId, ['bash', '-lc', command], { user: tpl.execUser, workdir, timeoutMs: (timeout_sec ?? BASH_TIMEOUT.def) * 1000, maxOutput: 256 * 1024, signal: host.abort?.signal });
          });
        } catch (e) {
          const msg = redact(e instanceof Error ? e.message : e).slice(0, 500);
          host.emit({ t: 'command', id, command: shown, status: 'failed', tail: msg, ms: Date.now() - t0 });
          throw new Error(msg);
        }
        const out = redact(res.output).trim(), good = res.exitCode === 0, ms = Date.now() - t0, reload = good && RELOADS.test(command);
        host.emit({ t: 'command', id, command: shown, status: good ? 'ok' : 'failed', exitCode: res.exitCode, tail: out.split('\n').slice(-15).join('\n').slice(-1500), ms });
        if (reload) host.emit({ t: 'preview_reload' });
        const body = `Exit-Code ${res.exitCode} nach ${(ms / 1000).toFixed(1)} s${reload ? ' – die Vorschau lädt neu' : ''}\n${tail(out, COMMAND_OUTPUT) || '(keine Ausgabe)'}`;
        return good ? ok(body) : fail(body);
      })),

    tool('pull_from_container', `Übernimmt Dateien, die IM Container neu entstanden oder geändert/gelöscht wurden (durch sandbox_bash oder in der Konsole des Nutzers, z. B. bin/console plugin:create, composer require in einem Plugin, generierte Migrationen), ins Repository – nur aus den Ordnern, die Lotse überträgt (Plugin-Ordner, beim ganzen Projekt custom/plugins|static-plugins|apps, config/packages, config/services*.yaml, src/, beim eigenen Setup der Zielordner). vendor/, node_modules/, var/ und public/ nur, wenn das Repository dort schon Dateien hat. Symlinks, Geheimnisse (.env, Schlüssel), GitHub-Workflows und zu große Dateien werden nicht übernommen – dieselben Prüfungen wie bei git_commit. Ohne paths alles, sonst nur diese Dateien/Ordner (relativ zur Repository-Wurzel); bei einer Sandbox ohne gemerkten Ausgangsstand (vor dieser Funktion eingerichtet) nur mit paths. Danach wie gewohnt prüfen und mit git_commit speichern.`,
      { paths: z.array(z.string().min(1).max(500)).min(1).max(COMMIT_LIMITS.paths).optional().describe('nur diese Dateien/Ordner; leer = alle Unterschiede') },
      act('pull_from_container', async ({ paths }) => {
        if (!task().layout) return fail('Die Einrichtung ist noch nicht fertig.');
        if (publishRunning(taskId)) return fail('Gerade wird veröffentlicht – später erneut übernehmen.');
        const under = paths?.map(p => assertCommitPath(relOf(worktree(), p)));
        await ensureAwake(taskId);
        const r = await withTaskLock(taskId, () => takeOver(task(), { all: true, under }, { signal: host.abort?.signal, via: 'ai' }));
        for (const f of r.taken) host.emit({ t: 'file_change', path: f.path, kind: f.status === 'added' ? 'create' : f.status === 'deleted' ? 'delete' : 'edit', added: f.added, removed: f.removed });
        const label: Record<string, string> = { added: 'neu', modified: 'geändert', deleted: 'gelöscht' };
        const skipText: Record<string, string> = { symlink: 'Symlink', special: 'Gerätedatei/FIFO', protected: 'geschützt (.env, Schlüssel, .git)', 'too-large': 'zu groß', unreadable: 'nicht lesbar', name: 'ungewöhnlicher Dateiname', more: 'über dem Limit dieses Vergleichs' };
        const lines = [
          r.taken.length ? `Übernommen (${r.taken.length}):\n${r.taken.map(f => `${label[f.status]} ${f.path} (+${f.added} −${f.removed})`).join('\n')}` : 'Nichts übernommen – Container und Repository stimmen in den übertragenen Ordnern überein.',
          ...(r.refused.length ? [`Nicht übernommen:\n${r.refused.map(f => `${f.path}: ${f.reason}`).join('\n')}`] : []),
          ...(r.skipped.length ? [`Übersprungen: ${r.skipped.slice(0, 30).map(f => `${f.path} (${skipText[f.reason] ?? f.reason})`).join(', ')}${r.skipped.length > 30 ? ' …' : ''}`] : []),
          ...(r.taken.length ? ['Noch nicht committet – prüfen und mit git_commit speichern.'] : []),
          ...(r.noBaseline && r.taken.length ? ['Hinweis: Diese Sandbox hat keinen gemerkten Ausgangsstand – Dateien des Images oder der Einrichtung können dabei sein; vor git_commit prüfen, dass nur deine Dateien übernommen wurden.'] : []),
        ];
        return ok(redact(lines.join('\n\n')));
      })),

    tool('delete_file', 'Löscht eine Datei des Repositorys (keine Ordner); auch im Container.',
      { path: z.string().min(1).max(500).describe('Pfad relativ zur Repository-Wurzel') },
      act('delete_file', async ({ path }) => changed(deleteText(worktree(), path)))),

    tool('git_diff', 'Zeigt alle bisherigen Änderungen gegenüber dem Basis-Branch (Dateiliste mit +/− und Patch, gekürzt), dazu deine lokalen Commits und was noch nicht committet ist.', {},
      act('git_diff', async () => {
        const d = await taskDiff(task(), DIFF_FOR_AI);
        const commits = d.commits?.length ? `Lokale Commits (neueste zuerst):\n${d.commits.map(c => `${c.sha.slice(0, 7)} ${c.subject}${c.published ? ' (veröffentlicht)' : ''}`).join('\n')}\n\n` : '';
        const open = d.uncommitted?.length ? `Noch nicht committet: ${d.uncommitted.slice(0, 50).join(', ')}${d.uncommitted.length > 50 ? ' …' : ''}\n\n` : '';
        if (!d.files.length) return ok(`${commits}${open}Keine Änderungen gegenüber dem Basis-Branch.`);
        return ok(`${commits}${open}${d.files.map(f => `${f.status} ${f.path} (+${f.added} −${f.removed})`).join('\n')}\n\n${d.diff}`);
      })),

    tool('git_commit', `Speichert Änderungen als lokalen Commit im Repository der Aufgabe – wie in Claude Code: nach jedem in sich abgeschlossenen, geprüften Schritt ein Commit mit eigener, aussagekräftiger Nachricht (erste Zeile kurz, höchstens ${COMMIT_LIMITS.subject} Zeichen, im Stil des Repositorys; optional eine Leerzeile und ein Text, warum). Ohne paths alle Änderungen, sonst nur diese Dateien/Ordner (relativ zur Repository-Wurzel). Nur lokal: kein Push, kein Branch-Wechsel, kein Ändern früherer Commits – gepusht und als Pull Request veröffentlicht wird erst mit dem Klick des Nutzers. Geschützte Dateien, GitHub-Workflows und alles, was wie ein Geheimnis aussieht, werden nicht committet.`,
      { message: z.string().min(1).max(COMMIT_LIMITS.message).describe('Commit-Nachricht: erste Zeile = Zusammenfassung'), paths: z.array(z.string().min(1).max(500)).min(1).max(COMMIT_LIMITS.paths).optional().describe('nur diese Dateien/Ordner; leer = alle Änderungen') },
      act('git_commit', async ({ message, paths }) => {
        const t = task(), { worktree: wt, gitDir } = taskPaths(taskId);
        if (!t.steps.some(s => s.key === 'clone' && s.state === 'done') || !fs.existsSync(wt)) return fail('Das Repository ist noch nicht geklont.');
        if (publishRunning(taskId)) return fail('Gerade wird veröffentlicht – später erneut committen.');
        // the message is pushed as it is, too (history is never rewritten): no secret in it, nothing to override
        const inMessage = findSecret(message);
        if (inMessage) return fail(`Nicht committet: Die Commit-Nachricht enthält etwas, das wie ein Geheimnis aussieht (${inMessage}). Ohne den Wert erneut committen.`);
        const rels = paths?.map(p => assertCommitPath(relOf(wt, p)));
        const pending = await pendingChanges(wt, gitDir, rels);
        if (!pending.length) return ok(rels ? `Keine Änderungen an ${rels.join(', ')} – nichts committet.` : 'Keine Änderungen – nichts committet.');
        // checked are the staged bytes, in the same step as the commit: a file written meanwhile by a parallel tool call is not committed unchecked
        const r = await commitChanges(wt, gitDir, message, LOTSE_AUTHOR, coAuthor(currentActor(t.chatId)), rels, (staged, head, read) => commitCheck(t, staged, head, read));
        if (!r) return ok('Keine Änderungen – nichts committet.');
        if ('blocked' in r) return fail(`${r.blocked}${rels ? '' : ' Mit paths nur die übrigen Dateien committen.'}`);
        const subject = redact(message.trim().split('\n')[0]);
        return ok(`Commit ${r.sha.slice(0, 7)} (${r.files === 1 ? '1 Datei' : `${r.files} Dateien`}): ${subject}. Nur lokal gespeichert – veröffentlicht wird erst mit dem Klick des Nutzers im Reiter „Freigabe“ (Pull Request).`);
      })),
    tool('read_sandbox_page', 'Ruft eine Seite der Sandbox-Storefront dieser Aufgabe ab (nur diese, z. B. "/" oder "/checkout/cart") und liefert Status, Titel und sichtbaren Text – mit format "html" den HTML-Quelltext (gekürzt). Zum Prüfen, ob eine Änderung wirkt.',
      { path: z.string().min(1).max(500).describe('Pfad der Storefront, beginnt mit /'), format: z.enum(['text', 'html']).optional() },
      act('read_sandbox_page', async ({ path, format }) => {
        if (!path.startsWith('/') || path.startsWith('//') || /[\s\\]/.test(path)) return fail('Pfad muss mit / beginnen (z. B. /navigation/… oder /).');
        await ensureAwake(taskId);
        const t = task();
        const r = await fetchUpstream(await sandboxUpstream(t), { method: 'GET', path, headers: { accept: 'text/html,*/*;q=0.5', 'user-agent': 'Lotse-Agent' } }, host.abort?.signal);
        const type = r.headers.get('content-type') ?? '';
        const loc = r.headers.get('location');
        const head = `HTTP ${r.status}${type ? ` · ${type.split(';')[0]}` : ''}${loc ? ` · Weiterleitung nach ${loc}` : ''}`;
        if (!/^(text\/|application\/(json|xml|javascript))/.test(type)) return ok(`${head}\n(kein Text)`);
        const raw = r.body.toString('utf8');
        if (format === 'html' || !/html/.test(type)) return ok(`${head}\n${redact(raw.length > PAGE_HTML ? `${raw.slice(0, PAGE_HTML)}\n…` : raw)}`);
        const p = pageText(raw);
        return ok(`${head}\nTitel: ${p.title || '–'}\n\n${redact(p.text.length > PAGE_TEXT ? `${p.text.slice(0, PAGE_TEXT)}\n…` : p.text)}`);
      })),

    tool('get_environment', 'Liest die Umgebung der Aufgabe: Vorlage, Image, Plugin/Theme und Pfad im Container, die Namen der Umgebungsvariablen (ohne Werte) und die eigenen Einrichtungsbefehle. Nur lesen – ändern kann das nur der Nutzer in der Umgebung.', {},
      act('get_environment', async () => {
        const t = task(), env = sandboxPublic(), tpl = getTemplate(t.template);
        const rf = t.repoFile;
        return ok({
          template: t.template, image: t.image || env.image, repo: t.repo || null, mode: t.layout?.kind === 'custom' ? 'eigenes Setup' : t.setup?.source === 'none' ? 'ohne Projekt (nur lokales Git)' : 'automatisch erkannt', baseBranch: t.baseBranch, branch: t.branch, status: t.status,
          layout: t.layout, containerPath: t.layout ? tpl.syncTarget(t.layout) : null,
          envVars: env.envVars.map(v => ({ key: v.key, secret: v.secret })),
          setupCommands: env.commands.map(c => ({ label: c.label, phase: c.phase, command: redact(c.command) })),
          sandboxCommands: (t.setup?.commands ?? []).map(c => ({ label: c.label, phase: c.phase, command: redact(c.command) })),
          sandboxEnvVars: (t.setup?.env ?? []).map(v => v.key),
          repoFile: rf ? { commands: rf.commands.map(c => ({ label: c.label, phase: c.phase, command: redact(c.command) })), state: rf.state, envNames: rf.env, previewPath: rf.previewPath ?? null } : null,
        });
      })),

    tool('ask_user', 'RÜCKFRAGE an den Nutzer mit anklickbaren Antworten (der Nutzer kann stattdessen frei tippen). Wartet auf die Antwort. Nur bei echten Unklarheiten (Ziel, Geschmack, mehrere sinnvolle Wege), pro Aufruf genau EINE Frage mit 2–4 Optionen.',
      { question: z.string().min(1), options: z.array(z.object({ label: z.string(), description: z.string().optional() })).min(1).max(5) },
      act('ask_user', async a => ok({ answer: await host.askUser(a) }))),

    tool('request_internet', 'Bittet den Nutzer um Internet für den Container dieser Aufgabe – nur wenn ein Befehl es wirklich braucht (z. B. composer require, npm install, ein Download). Zeigt eine Karte mit deinem Grund und WARTET auf die Entscheidung; erst der Klick des Nutzers verbindet den Container mit dem Internet. Mit Internet erreicht der Container jede öffentliche Adresse, auch die Website des Live-Shops: rufe dort nichts ab und ändere nichts. Der Zugang endet, wenn der Nutzer ihn sperrt oder die Sandbox pausiert bzw. abgeschlossen wird.',
      { reason: z.string().min(1).max(300).describe('Ein Satz: wofür Internet gebraucht wird (z. B. „composer require für die Bibliothek X“)') },
      act('request_internet', async ({ reason }) => {
        if (task().internet) return ok('Internet ist für diese Aufgabe bereits freigegeben.');
        const blocked = internetBlocked();
        if (blocked) return fail(`${blocked} Ohne Internet weiterarbeiten oder den Nutzer fragen.`);
        await ensureAwake(taskId);
        const why = redact(reason).replace(/\s+/g, ' ').trim();
        const approvalId = `inet_${crypto.randomBytes(6).toString('hex')}`;
        host.emit({ t: 'internet_request', approvalId, reason: why });
        const dec = await new Promise<ApprovalReply>(r => host.approvals.set(approvalId, r));
        host.approvals.delete(approvalId);
        if (!dec.allow) { noteInternetDenied(taskId, why); return fail('Der Nutzer hat den Internetzugang abgelehnt. Ohne Internet weiterarbeiten oder den Nutzer fragen, wie es weitergehen soll.'); }
        try { await grantInternet(taskId, { via: 'chat', reason: why }); } catch (e) {
          // the click is already stored as "allowed": the card says what happened instead, and the audit keeps the click
          const error = e instanceof Error ? e.message : String(e);
          noteInternetFailed(taskId, why, error);
          host.emit({ t: 'internet_request', approvalId, reason: why, decision: false, error });
          return fail(`Internet konnte nicht freigegeben werden: ${error} Ohne Internet weiterarbeiten oder den Nutzer fragen.`);
        }
        return ok('Internet ist für diesen Container jetzt freigegeben (bis der Nutzer es sperrt oder die Sandbox pausiert). Nur für den genannten Zweck verwenden.');
      })),

    tool('propose_publish', 'Schlägt vor, die Änderungen als Pull Request zu veröffentlichen: zeigt dem Nutzer eine Karte mit Titel und Beschreibung. Veröffentlicht NICHTS selbst – das entscheidet der Nutzer. Erst aufrufen, wenn die Änderung in der Vorschau geprüft ist.',
      { title: z.string().min(1).max(120).describe('Titel des Pull Requests (kurz, Deutsch)'), body: z.string().max(5000).describe('Beschreibung: was, warum, wie geprüft (Markdown)') },
      act('propose_publish', async ({ title, body }) => {
        host.emit({ t: 'publish_proposal', title: title.trim(), body: redact(body).trim() });
        return ok('Vorschlag angezeigt. Der Nutzer prüft ihn im Reiter „Freigabe“ (Pull Request) und veröffentlicht selbst (oder nicht).');
      })),

    tool('propose_zip', 'Schlägt vor, das Plugin als ZIP für den Live-Shop herunterzuladen (Shopware-Admin → Erweiterungen → Erweiterung hochladen): zeigt dem Nutzer eine Karte mit einem Hinweis. Erzeugt und lädt NICHTS selbst – den Download löst der Nutzer im Reiter „Freigabe“ aus, nachdem Lotse composer.json geprüft hat. Erst aufrufen, wenn die Änderung in der Vorschau geprüft und committet ist; composer.json (Beschreibung, Version, Anzeigename) vorher vollständig machen.',
      { note: z.string().min(1).max(1000).describe('Kurzer Hinweis für den Nutzer, Deutsch: welches Plugin und was beim Einspielen zu beachten ist (z. B. Version erhöht, danach Plugin aktualisieren und Cache leeren)') },
      act('propose_zip', async ({ note }) => {
        host.emit({ t: 'zip_proposal', note: redact(note).trim() });
        return ok('Karte angezeigt. Der Nutzer lädt das ZIP selbst im Reiter „Freigabe“ herunter; Lotse nennt dort, was in composer.json noch fehlt. Bis dahin nichts weiter tun.');
      })),
  ] as AnyTool[];
}

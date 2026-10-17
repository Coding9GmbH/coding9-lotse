import 'server-only';
// MCP tools of a chat with an attached sandbox (Sandbox Coding), the same for Claude (in-process) and Codex (over HTTP).
// Files are read and edited with the agent's own tools (Claude: Read/Edit/Write/Glob/Grep, see native-tools.ts; Codex: its patches),
// confined to the task's worktree. Here only what those do not cover: sandbox_bash (any shell command INSIDE the task container,
// never on the host), delete_file, git_diff, the task's own storefront, the environment, questions, the PR proposal and request_internet
// (asks the human; only the click attaches the container to the internet, internet.ts).
// Codex has no file reading of its own without a shell, so it also gets list_files/read_file/search_files.
// Nothing commits, pushes, calls GitHub or controls Docker beyond the container exec. Cheap to build, no side effects.
import crypto from 'node:crypto';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { ChatEvent } from '@/lib/protocol';
import { accessAdd } from '../db';
import { decodeEntities } from '../html-sanitize';
import { redact } from '../settings';
import { fail, guard, ok, type AnyTool, type ToolResult } from '../tool-kit';
import type { ApprovalReply, Question } from '../sessions';
import { taskDiff } from './diff';
import { sandboxPublic } from './env';
import { grantInternet, internetBlocked, noteInternetDenied, noteInternetFailed } from './internet';
import { ensureAwake, touchTask, withTaskLock } from './jobs';
import { fetchUpstream, sandboxUpstream } from './preview';
import { getRunner } from './runner';
import { syncAll, syncPaths } from './sync';
import { getTemplate } from './templates';
import { mustTask, settleNewPlugin, taskPaths, type CodeTask } from './tasks';
import { deleteText, listFiles, readText, searchFiles, type Change } from './workspace-fs';

/** MCP tools of every sandbox chat */
export const SANDBOX_TOOL_NAMES = ['sandbox_bash', 'delete_file', 'git_diff', 'read_sandbox_page', 'get_environment', 'ask_user', 'request_internet', 'propose_publish'] as const;
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
    const t = mustTask(taskId), tpl = getTemplate(t.template);
    if (!t.containerId || !t.containerRunning || !t.layout) return ' (Container pausiert: wird beim Fortsetzen übertragen)';
    await syncPaths({ runner: getRunner(), containerId: t.containerId, worktree: taskPaths(taskId).worktree, target: tpl.syncTarget(t.layout), user: tpl.execUser }, rels);
    return ' und in den Container übertragen';
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
    tool('sandbox_bash', `Führt einen Shell-Befehl IM Container der Aufgabe aus (bash -lc, als www-data in /var/www/html; der Container ist ein Wegwerf-Shopware, normalerweise ohne Internet; braucht ein Befehl Internet, erst request_internet). Vorher wird das Repository in den Container übertragen. Für bin/console (z. B. theme:compile, cache:clear, plugin:refresh), Logs (var/log), mysql -uroot -proot -h127.0.0.1 shopware, curl -H 'Host: localhost' http://127.0.0.1/…, php -l usw. Nach theme:compile/cache:clear lädt die Vorschau neu. Dateien des Repositorys änderst du NICHT hier (Änderungen im Container gehen beim nächsten Übertragen verloren), sondern mit den Datei-Werkzeugen. Zeitlimit Standard ${BASH_TIMEOUT.def} s, höchstens ${BASH_TIMEOUT.max} s; die Ausgabe wird gekürzt (Ende) und geschwärzt.`,
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
            await syncAll({ runner: getRunner(), containerId: fresh.containerId, worktree: worktree(), target: tpl.syncTarget(fresh.layout), user: tpl.execUser, signal: host.abort?.signal });
            return getRunner().exec(fresh.containerId, ['bash', '-lc', command], { user: tpl.execUser, workdir: tpl.workdir, timeoutMs: (timeout_sec ?? BASH_TIMEOUT.def) * 1000, maxOutput: 256 * 1024, signal: host.abort?.signal });
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

    tool('delete_file', 'Löscht eine Datei des Repositorys (keine Ordner); auch im Container.',
      { path: z.string().min(1).max(500).describe('Pfad relativ zur Repository-Wurzel') },
      act('delete_file', async ({ path }) => changed(deleteText(worktree(), path)))),

    tool('git_diff', 'Zeigt alle bisherigen Änderungen gegenüber dem Basis-Branch (Dateiliste mit +/− und Patch, gekürzt).', {},
      act('git_diff', async () => {
        const d = await taskDiff(task(), DIFF_FOR_AI);
        if (!d.files.length) return ok('Keine Änderungen gegenüber dem Basis-Branch.');
        return ok(`${d.files.map(f => `${f.status} ${f.path} (+${f.added} −${f.removed})`).join('\n')}\n\n${d.diff}`);
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
        return ok({
          template: t.template, image: env.image, repo: t.repo, baseBranch: t.baseBranch, branch: t.branch, status: t.status,
          layout: t.layout, containerPath: t.layout ? tpl.syncTarget(t.layout) : null,
          envVars: env.envVars.map(v => ({ key: v.key, secret: v.secret })),
          setupCommands: env.commands.map(c => ({ label: c.label, phase: c.phase, command: redact(c.command) })),
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
        return ok('Vorschlag angezeigt. Der Nutzer prüft ihn im Reiter „Pull Request“ und veröffentlicht selbst (oder nicht).');
      })),
  ] as AnyTool[];
}

import 'server-only';
// Tools of a code chat (Sandbox Coding), the same for Claude (in-process MCP) and Codex (MCP over HTTP).
// They only reach the task's worktree (workspace-fs: realpath-confined), allow-listed commands of the template in the task container
// and the task's own storefront. Nothing commits, pushes, calls GitHub or controls Docker beyond run_command; nothing runs on the host.
// Every write is mirrored into the container at once and shown as a file_change card. Cheap to build, no side effects.
import crypto from 'node:crypto';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { ChatEvent, SandboxCommandKey } from '@/lib/protocol';
import { accessAdd } from '../db';
import { decodeEntities } from '../html-sanitize';
import { redact } from '../settings';
import { fail, guard, ok, type AnyTool, type ToolResult } from '../tool-kit';
import type { Question } from '../sessions';
import { taskDiff } from './diff';
import { sandboxPublic } from './env';
import { ensureAwake, touchTask, withTaskLock } from './jobs';
import { fetchUpstream, sandboxUpstream } from './preview';
import { getRunner } from './runner';
import { syncAll, syncPaths } from './sync';
import { getTemplate, resolveCommand } from './templates';
import { mustTask, taskPaths, type CodeTask } from './tasks';
import { deleteText, editText, listFiles, readText, searchFiles, writeText, type Change } from './workspace-fs';

export const CODE_TOOL_NAMES = ['list_files', 'read_file', 'search_files', 'edit_file', 'write_file', 'delete_file', 'git_diff', 'run_command', 'read_sandbox_page', 'get_environment', 'ask_user', 'propose_publish'] as const;
/** Output of run_command for the AI (end of the output, redacted) */
export const COMMAND_OUTPUT = 8 * 1024;
const DIFF_FOR_AI = 30 * 1024, PAGE_TEXT = 12 * 1024, PAGE_HTML = 30 * 1024;
/** Commands after which the storefront looks different: the preview reloads */
const RELOADS = new Set<string>(['theme-compile', 'cache-clear', 'theme-refresh']);

/** What the tools need from the chat session. */
export interface CodeToolHost {
  id: string;
  taskId: string | null;
  emit: (ev: ChatEvent) => void;
  askUser: (q: Question) => Promise<string>;
  abort: AbortController | null;
}

const tail = (text: string, max: number) => (Buffer.byteLength(text) > max ? `…${Buffer.from(text).subarray(-max).toString('utf8').replace(/^�+/, '')}` : text);

/** Visible text of an HTML page: title + text without scripts, styles and tags. */
export function pageText(html: string): { title: string; text: string } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  const body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\/?(p|div|section|article|header|footer|nav|main|aside|h[1-6]|li|ul|ol|tr|table|br|form|button|a|label|option)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(body).split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
  return { title, text };
}

export function codeTools(host: CodeToolHost): AnyTool[] {
  const taskId = host.taskId ?? '';
  const task = (): CodeTask => mustTask(taskId);
  const worktree = () => taskPaths(taskId).worktree;
  const log = (op: string, n = 1, denied?: string) => { try { accessAdd({ chat: host.id, op, entity: `repo:${task().repo}`, n, denied: denied ?? null }); } catch { /* log only */ } };
  /** Every call counts as activity (the idle sweeper keeps the container); refusals are logged as denied. */
  const act = <A>(op: string, fn: (a: A) => Promise<ToolResult>) => guard(async (a: A) => {
    touchTask(taskId);
    try { const r = await fn(a); log(op); return r; } catch (e) { log(op, 0, e instanceof Error ? e.message.slice(0, 200) : 'Fehler'); throw e; }
  });

  /** Mirror changed files into the running container (under the task lock); a paused one gets everything when it wakes. */
  const sync = async (rels: string[]): Promise<string> => withTaskLock(taskId, async () => {
    const t = task(), tpl = getTemplate(t.template);
    if (!t.containerId || !t.containerRunning || !t.layout) return ' (Container pausiert: wird beim Fortsetzen übertragen)';
    await syncPaths({ runner: getRunner(), containerId: t.containerId, worktree: worktree(), target: tpl.syncTarget(t.layout), user: tpl.execUser }, rels);
    return ' und in den Container übertragen';
  }).catch(e => ` – Übertragung in den Container fehlgeschlagen: ${redact(e instanceof Error ? e.message : e).slice(0, 300)}`);
  const changed = async (c: Change, extra = '') => {
    const note = await sync([c.path]);
    host.emit({ t: 'file_change', path: c.path, kind: c.kind, added: c.added, removed: c.removed });
    return ok(`${c.path}: ${c.kind === 'create' ? 'angelegt' : c.kind === 'delete' ? 'gelöscht' : 'geändert'} (+${c.added} −${c.removed})${extra}${note}.`);
  };

  const commandIds = () => getTemplate(task().template).commands.map(c => c.id);

  return [
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

    tool('edit_file', 'Ändert eine Datei: ersetzt old_str durch new_str. old_str muss genau einmal vorkommen (sonst mehr Kontext angeben oder replace_all). Die Änderung wird sofort in den Container übertragen.',
      { path: z.string().min(1).max(500), old_str: z.string().min(1), new_str: z.string(), replace_all: z.boolean().optional() },
      act('edit_file', async ({ path, old_str, new_str, replace_all }) => {
        const c = editText(worktree(), path, old_str, new_str, replace_all);
        return changed(c, c.replaced > 1 ? `, ${c.replaced} Stellen` : '');
      })),

    tool('write_file', 'Legt eine Datei an oder überschreibt sie komplett (höchstens 512 KB). Fehlende Ordner werden angelegt. Für kleine Änderungen lieber edit_file.',
      { path: z.string().min(1).max(500), content: z.string() },
      act('write_file', async ({ path, content }) => changed(writeText(worktree(), path, content)))),

    tool('delete_file', 'Löscht eine Datei des Repositorys (keine Ordner); auch im Container.',
      { path: z.string().min(1).max(500) },
      act('delete_file', async ({ path }) => changed(deleteText(worktree(), path)))),

    tool('git_diff', 'Zeigt alle bisherigen Änderungen gegenüber dem Basis-Branch (Dateiliste mit +/− und Patch, gekürzt).', {},
      act('git_diff', async () => {
        const d = await taskDiff(task(), DIFF_FOR_AI);
        if (!d.files.length) return ok('Keine Änderungen gegenüber dem Basis-Branch.');
        return ok(`${d.files.map(f => `${f.status} ${f.path} (+${f.added} −${f.removed})`).join('\n')}\n\n${d.diff}`);
      })),

    tool('run_command', 'Führt einen freigegebenen Befehl im Container der Aufgabe aus (als www-data in /var/www/html; vorher wird das Repository übertragen). Nur diese IDs: theme-compile (Theme kompilieren, danach lädt die Vorschau neu), cache-clear, plugin-refresh, theme-refresh, lint-twig (args.path: Twig-Datei relativ zum Plugin), php-lint (args.path: PHP-Datei relativ zum Plugin). Keine eigenen Shell-Befehle.',
      { command: z.string().min(1).max(40), args: z.record(z.string(), z.string().max(300)).optional() },
      act('run_command', async ({ command, args }) => {
        const t = task(), tpl = getTemplate(t.template);
        if (!commandIds().includes(command as SandboxCommandKey)) return fail(`Befehl „${command.slice(0, 40)}“ ist nicht freigegeben (erlaubt: ${commandIds().join(', ')}).`);
        if (!t.layout) return fail('Die Einrichtung ist noch nicht fertig.');
        const r = resolveCommand(tpl, command, args ?? {}, { pluginDir: t.layout.pluginDir });
        await ensureAwake(taskId); // paused meanwhile (idle, button): start it again, no new setup
        const id = `cmd_${crypto.randomBytes(6).toString('hex')}`, t0 = Date.now();
        host.emit({ t: 'command', id, command, ...(args && Object.keys(args).length ? { args } : {}), status: 'running' });
        let res: { exitCode: number; output: string };
        try {
          res = await withTaskLock(taskId, async () => {
            const fresh = task();
            if (!fresh.containerId || !fresh.containerRunning || !fresh.layout) throw new Error('Der Container läuft nicht.');
            await syncAll({ runner: getRunner(), containerId: fresh.containerId, worktree: worktree(), target: tpl.syncTarget(fresh.layout), user: tpl.execUser, signal: host.abort?.signal });
            return getRunner().exec(fresh.containerId, r.argv, { user: r.user, workdir: r.workdir, timeoutMs: r.timeoutMs, maxOutput: r.maxOutput, signal: host.abort?.signal });
          });
        } catch (e) {
          const msg = redact(e instanceof Error ? e.message : e).slice(0, 500);
          host.emit({ t: 'command', id, command, status: 'failed', tail: msg, ms: Date.now() - t0 });
          throw new Error(msg);
        }
        const out = redact(res.output).trim(), good = res.exitCode === 0, ms = Date.now() - t0;
        host.emit({ t: 'command', id, command, status: good ? 'ok' : 'failed', exitCode: res.exitCode, tail: out.split('\n').slice(-15).join('\n').slice(-1500), ms });
        if (good && RELOADS.has(command)) host.emit({ t: 'preview_reload' });
        const body = `${command}: Exit-Code ${res.exitCode} nach ${(ms / 1000).toFixed(1)} s${good && RELOADS.has(command) ? ' – die Vorschau lädt neu' : ''}\n${tail(out, COMMAND_OUTPUT) || '(keine Ausgabe)'}`;
        return good ? ok(body) : fail(body);
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

    tool('get_environment', 'Liest die Umgebung der Aufgabe: Vorlage, Image, Plugin/Theme und Pfad im Container, freigegebene Befehle, die Namen der Umgebungsvariablen (ohne Werte) und die eigenen Einrichtungsbefehle. Nur lesen – ändern kann das nur der Nutzer in der Umgebung.', {},
      act('get_environment', async () => {
        const t = task(), env = sandboxPublic(), tpl = getTemplate(t.template);
        return ok({
          template: t.template, image: env.image, repo: t.repo, baseBranch: t.baseBranch, branch: t.branch, status: t.status,
          layout: t.layout, containerPath: t.layout ? tpl.syncTarget(t.layout) : null,
          commands: tpl.commands.map(c => ({ id: c.id, args: c.args.map(a => a.name) })),
          envVars: env.envVars.map(v => ({ key: v.key, secret: v.secret })),
          setupCommands: env.commands.map(c => ({ label: c.label, phase: c.phase, command: redact(c.command) })),
        });
      })),

    tool('ask_user', 'RÜCKFRAGE an den Nutzer mit anklickbaren Antworten (der Nutzer kann stattdessen frei tippen). Wartet auf die Antwort. Nur bei echten Unklarheiten (Ziel, Geschmack, mehrere sinnvolle Wege), pro Aufruf genau EINE Frage mit 2–4 Optionen.',
      { question: z.string().min(1), options: z.array(z.object({ label: z.string(), description: z.string().optional() })).min(1).max(5) },
      act('ask_user', async a => ok({ answer: await host.askUser(a) }))),

    tool('propose_publish', 'Schlägt vor, die Änderungen als Pull Request zu veröffentlichen: zeigt dem Nutzer eine Karte mit Titel und Beschreibung. Veröffentlicht NICHTS selbst – das entscheidet der Nutzer. Erst aufrufen, wenn die Änderung in der Vorschau geprüft ist.',
      { title: z.string().min(1).max(120).describe('Titel des Pull Requests (kurz, Deutsch)'), body: z.string().max(5000).describe('Beschreibung: was, warum, wie geprüft (Markdown)') },
      act('propose_publish', async ({ title, body }) => {
        host.emit({ t: 'publish_proposal', title: title.trim(), body: redact(body).trim() });
        return ok('Vorschlag angezeigt. Der Nutzer entscheidet über das Veröffentlichen.');
      })),
  ] as AnyTool[];
}

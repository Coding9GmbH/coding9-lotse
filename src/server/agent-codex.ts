import 'server-only';
// Codex runtime (ChatGPT subscription): same shop tools as with Claude, but via a Lotse MCP endpoint (/api/mcp/<chatId>).
import fs from 'node:fs';
import path from 'node:path';
import { Codex, type ThreadItem, type ThreadOptions } from '@openai/codex-sdk';
import type { ChatEvent } from '@/lib/protocol';
import { bindRoundToken, codexConfig, codexEnv, codexLoggedIn, mcpTokenFor } from './codex';
import { buildSystem, codeSystemFor } from './prompt';
import { persist, type Session } from './sessions';
import { messages } from '@/lib/i18n';
import type { Locale } from '@/lib/i18n/locales';
import type { RunEnd, RunUsage } from './agent';
import { getSettings, redact } from './settings';
import { errMsg } from './util';
import { runGit } from './git';
import { relOf } from './sandbox/native-tools';
import { taskPaths } from './sandbox/tasks';
import { resolveInWorkspace } from './sandbox/workspace-fs';
import { syncChanged } from './sandbox/workspace-tools';

// Addition to the system prompt: otherwise Codex assumes its role as a coding agent
const CODEX_NOTE = `\n\n## Laufzeit
Du läufst in Lotse, nicht als Programmier-Assistent. Du hast ausschließlich die Werkzeuge des MCP-Servers „shop“ (z. B. search_products, draft_page, ask_user, propose_product_changes). Führe keine Befehle aus, lies oder schreibe keine Dateien und frage nicht nach solchen Rechten. Das ist hier technisch gesperrt.`;
const CODEX_WEB_NOTE = ' Zusätzlich darfst du die Websuche verwenden (Internetrecherche ist eingeschaltet).';
// Chats with an attached sandbox: Codex reads, edits and runs commands only through the MCP tools (write_file/edit_file are checked and
// mirrored into the container by Lotse). Its own patches stay off (read-only): apply_patch runs inside bubblewrap, which needs user
// namespaces that a hardened Docker host refuses – the patch then failed and nothing was saved. Its own shell would run on the Lotse host.
export const CODE_NOTE = `\n\n## Laufzeit
Du läufst in Lotse als Coding-Assistent in der Sandbox dieses Chats. Dein Arbeitsverzeichnis ist das Repository. Dateien liest und suchst du mit list_files/read_file/search_files und änderst sie NUR mit edit_file (gezielte Ersetzung, bevorzugt) bzw. write_file (neue Datei oder ganz neu schreiben), löschen mit delete_file – nur innerhalb des Repositorys, ohne .git und geheime Dateien. Dein eigenes apply_patch ist hier gesperrt (schreibgeschützt); versuche es nicht. Befehle NUR mit sandbox_bash (läuft im Container der Sandbox, ohne Internet – Internet nur nach Freigabe des Nutzers über request_internet). Committen NUR mit git_commit (lokaler Commit in sinnvollen Schritten, wie im Abschnitt „Vorgehen“ beschrieben) – kein git in einer Shell, kein Push. Eine eigene Shell gibt es hier nicht: Befehle außerhalb von sandbox_bash brechen die Runde ab.`;

/** Internal address at which the Codex process reaches Lotse (same machine/container). */
const internalUrl = () => (process.env.LOTSE_INTERNAL_URL || `http://127.0.0.1:${process.env.PORT || 3333}`).replace(/\/$/, '');

/** Developer instructions: the shop prompt with CODEX_NOTE, or with an attached sandbox the code prompt with CODE_NOTE. */
export const codexInstructions = (s: Pick<Session, 'taskId' | 'platform' | 'locale'> | null, web = false) =>
  (s?.taskId ? codeSystemFor(s.taskId, s.locale, web) + CODE_NOTE : buildSystem(s?.platform, s?.locale, web) + CODEX_NOTE) + (web ? CODEX_WEB_NOTE : '');

function client(chatId: string, instructions: string, web = false, workspace?: string) {
  const cfg = codexConfig({ mcpUrl: `${internalUrl()}/api/mcp/${encodeURIComponent(chatId)}`, instructions, web, workspace });
  const codex = new Codex({ env: codexEnv({ LOTSE_MCP_TOKEN: mcpTokenFor(chatId) }), config: cfg.config, configOverrides: cfg.configOverrides });
  const opts = codexThreadOptions(cfg.workingDirectory, getSettings().ai.codexModel, web);
  return { codex, opts };
}

/** Thread options for every run. Always a read-only sandbox (in a sandbox chat Codex writes through write_file/edit_file), no network
 *  for commands, no approval prompt; web search only with `web` (web research). */
export function codexThreadOptions(workingDirectory: string, model?: string, web = false): ThreadOptions {
  return {
    workingDirectory, skipGitRepoCheck: true, sandboxMode: 'read-only', approvalPolicy: 'never',
    networkAccessEnabled: false, webSearchMode: web ? 'live' : 'disabled', ...(model ? { model } : {}),
  };
}

const KIND = { add: 'create', update: 'edit', delete: 'delete' } as const;
/** Paths of a Codex patch relative to the worktree; throws if one lies outside or is .git/a secret/vendor. */
export function patchPaths(root: string, changes: { path: string }[]): string[] {
  return changes.map(c => resolveInWorkspace(root, relOf(root, c.path), { forWrite: true }).rel);
}

/** Undoes the refused paths of a patch Codex has already applied (it reports file changes only afterwards): a path in HEAD is
 *  restored from there, anything else (created by the patch) deleted. Only entries whose real parent lies inside the worktree,
 *  never .git; returns the reverted relative paths. */
export async function revertPaths(worktree: string, gitDir: string, paths: string[]): Promise<string[]> {
  const realRoot = fs.realpathSync(worktree), done: string[] = [];
  for (const p of paths) {
    let rel: string;
    try { rel = path.posix.normalize(relOf(worktree, p)); } catch { continue; }
    if (!rel || rel === '.' || rel === '..' || rel.startsWith('../') || rel.split('/').some(seg => seg.toLowerCase() === '.git')) continue;
    let parent: string;
    try { parent = fs.realpathSync(path.dirname(path.join(realRoot, rel))); } catch { continue; }
    if (parent !== realRoot && !parent.startsWith(realRoot + path.sep)) continue;
    const restored = await runGit(['--literal-pathspecs', 'checkout', 'HEAD', '--', rel], { cwd: worktree, gitDir }).then(() => true, () => false);
    if (!restored) try { fs.rmSync(path.join(parent, path.basename(rel)), { force: true }); } catch { continue; }
    done.push(rel);
  }
  return done;
}

const resultText = (item: Extract<ThreadItem, { type: 'mcp_tool_call' }>) =>
  item.error?.message ?? (item.result?.content ?? []).map(c => ('text' in c ? c.text : '')).join('');



/** One event of the Codex turn. Command, file change outside a sandbox chat and (without web research) web search end the turn.
 *  In a sandbox chat its own patches are refused by the read-only sandbox; should one still apply, it is checked like before (paths
 *  inside the worktree mirrored, the rest reverted). New SDK types must be classified here. */
export function onCodexItem(
  item: ThreadItem,
  evType: 'item.started' | 'item.updated' | 'item.completed',
  state: { texts: Map<string, number>; tools: Set<string>; web?: boolean; /** worktree of the attached sandbox (patches allowed there) */ sandbox?: string },
  emit: (ev: ChatEvent) => void,
  locale?: Locale,
): { abort?: string; /** patched paths (relative): mirror them into the container */ files?: string[]; /** refused paths of an applied patch: revert them */ revert?: string[] } {
  switch (item.type) {
    case 'agent_message': {
      const sent = state.texts.get(item.id);
      if (sent === undefined) emit({ t: 'text_start' });
      const delta = item.text.slice(sent ?? 0);
      if (delta) emit({ t: 'text', text: delta });
      state.texts.set(item.id, item.text.length);
      return {};
    }
    case 'mcp_tool_call': {
      if (!state.tools.has(item.id)) { state.tools.add(item.id); emit({ t: 'tool', id: item.id, name: item.tool, input: item.arguments }); }
      if (evType === 'item.completed') emit({ t: 'tool_result', id: item.id, error: item.status === 'failed' || !!item.error, preview: redact(resultText(item)).slice(0, 300) });
      return {};
    }
    case 'web_search': {
      if (!state.web) return { abort: messages(locale).server.codexBlockedTool };
      if (!state.tools.has(item.id)) { state.tools.add(item.id); emit({ t: 'tool', id: item.id, name: 'web_search', input: { query: item.query } }); }
      return {};
    }
    case 'file_change': {
      if (!state.sandbox) return { abort: messages(locale).server.codexBlockedTool };
      if (evType !== 'item.completed' || item.status !== 'completed') return {};
      const files: string[] = [], revert: string[] = [];
      for (const c of item.changes) {
        let rel: string;
        try { [rel] = patchPaths(state.sandbox, [c]); } catch { revert.push(c.path); continue; }
        files.push(rel);
        emit({ t: 'file_change', path: rel, kind: KIND[c.kind], added: 0, removed: 0 });
      }
      return revert.length ? { abort: messages(locale).server.codexOutsideWorkspace, files, revert } : { files };
    }
    case 'command_execution':
      return { abort: messages(locale).server.codexBlockedTool };
    case 'reasoning': case 'todo_list': case 'error':
      return {};
    default: {
      const uncovered: never = item;
      return uncovered;
    }
  }
}

/** One chat turn with Codex. Abort via `signal` (client gone). The MCP token stays valid until the end, including during an approval. */
export async function runCodex(s: Session, prompt: string, signal: AbortSignal, emit: (ev: ChatEvent) => void): Promise<RunEnd> {
  return bindRoundToken(s.id, async () => {
    const t = messages(s.locale).server;
    if (!codexLoggedIn()) return { error: t.codexNotLoggedIn };
    const ac = new AbortController();
    if (signal.aborted) ac.abort(); else signal.addEventListener('abort', () => ac.abort(), { once: true });
    const texts = new Map<string, number>(); // agent_message ID → characters already sent
    const tools = new Set<string>();
    let failed: string | null = null, usage: RunUsage | undefined;
    const model = getSettings().ai.codexModel || undefined, web = getSettings().scopes.web;
    try {
      const workspace = s.taskId ? taskPaths(s.taskId).worktree : undefined;
      const { codex, opts } = client(s.id, codexInstructions(s, web), web, workspace);
      const thread = s.codexThreadId ? codex.resumeThread(s.codexThreadId, opts) : codex.startThread(opts);
      const { events } = await thread.runStreamed(prompt, { signal: ac.signal });
      for await (const ev of events) {
        if (ev.type === 'thread.started') { s.codexThreadId = ev.thread_id; persist(s); continue; }
        if (ev.type === 'turn.failed') { failed = ev.error.message; continue; }
        if (ev.type === 'error') { failed = ev.message; continue; }
        if (ev.type === 'turn.completed') { const u = ev.usage; usage = { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cached_input_tokens, cacheWrite: u.cache_write_input_tokens }; continue; }
        if (ev.type !== 'item.started' && ev.type !== 'item.updated' && ev.type !== 'item.completed') continue;
        const stop = onCodexItem(ev.item, ev.type, { texts, tools, web, sandbox: workspace }, emit, s.locale);
        if (stop.abort) { failed = stop.abort; ac.abort(); }
        if (stop.revert?.length && s.taskId && workspace) await revertPaths(workspace, taskPaths(s.taskId).gitDir, stop.revert).catch(() => []);
        if (stop.files?.length && s.taskId) await syncChanged(s.taskId, stop.files);
      }
      persist(s);
      return { error: failed, ...(model ? { model } : {}), ...(usage ? { usage } : {}) };
    } catch (e) {
      persist(s);
      return { error: failed ?? (ac.signal.aborted ? t.runCancelled : redact(errMsg(e))) };
    }
  });
}

/** Connection test: short turn without tools. */
export async function pingCodex(): Promise<string> {
  return bindRoundToken('ping', async () => {
    if (!codexLoggedIn()) throw new Error('Nicht mit ChatGPT angemeldet. Zuerst „Mit ChatGPT anmelden“ (Einstellungen).');
    const { codex, opts } = client('ping', codexInstructions(null));
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 90_000);
    try {
      const turn = await codex.startThread(opts).run('Antworte exakt mit dem Wort: OK', { signal: ac.signal });
      return turn.finalResponse;
    } finally { clearTimeout(t); }
  });
}

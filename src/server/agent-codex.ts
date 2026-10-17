import 'server-only';
// Codex runtime (ChatGPT subscription): same shop tools as with Claude, but via a Lotse MCP endpoint (/api/mcp/<chatId>).
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

// Addition to the system prompt: otherwise Codex assumes its role as a coding agent
const CODEX_NOTE = `\n\n## Laufzeit
Du läufst in Lotse, nicht als Programmier-Assistent. Du hast ausschließlich die Werkzeuge des MCP-Servers „shop“ (z. B. search_products, draft_page, ask_user, propose_product_changes). Führe keine Befehle aus, lies oder schreibe keine Dateien und frage nicht nach solchen Rechten. Das ist hier technisch gesperrt.`;
const CODEX_WEB_NOTE = ' Zusätzlich darfst du die Websuche verwenden (Internetrecherche ist eingeschaltet).';
// Code chats (Sandbox Coding): same tools as Claude via MCP; Codex' own shell, apply_patch and file access stay blocked
export const CODE_NOTE = `\n\n## Laufzeit
Du läufst in Lotse als Coding-Assistent für genau diese Aufgabe. Du hast ausschließlich die Werkzeuge des MCP-Servers „shop“ (list_files, read_file, search_files, edit_file, write_file, delete_file, git_diff, run_command, read_sandbox_page, get_environment, ask_user, propose_publish). Eigene Befehle, eigene Dateizugriffe (Shell, apply_patch) und Netzwerk sind technisch gesperrt und brechen die Runde ab: Dateien änderst du nur mit edit_file/write_file/delete_file, Befehle nur mit run_command.`;

/** Internal address at which the Codex process reaches Lotse (same machine/container). */
const internalUrl = () => (process.env.LOTSE_INTERNAL_URL || `http://127.0.0.1:${process.env.PORT || 3333}`).replace(/\/$/, '');

/** Developer instructions: the shop prompt with CODEX_NOTE, or in a code chat the code prompt with CODE_NOTE. */
export const codexInstructions = (s: Pick<Session, 'mode' | 'taskId' | 'platform' | 'locale'> | null, web = false) =>
  (s?.mode === 'code' ? codeSystemFor(s.taskId, s.locale, web) + CODE_NOTE : buildSystem(s?.platform, s?.locale, web) + CODEX_NOTE) + (web ? CODEX_WEB_NOTE : '');

function client(chatId: string, instructions: string, web = false) {
  const cfg = codexConfig({ mcpUrl: `${internalUrl()}/api/mcp/${encodeURIComponent(chatId)}`, instructions, web });
  const codex = new Codex({ env: codexEnv({ LOTSE_MCP_TOKEN: mcpTokenFor(chatId) }), config: cfg.config, configOverrides: cfg.configOverrides });
  const opts = codexThreadOptions(cfg.workingDirectory, getSettings().ai.codexModel, web);
  return { codex, opts };
}

/** Thread options for every run. Read-only sandbox, no network for commands, no approval prompt; web search only with `web` (web research). */
export function codexThreadOptions(workingDirectory: string, model?: string, web = false): ThreadOptions {
  return {
    workingDirectory, skipGitRepoCheck: true, sandboxMode: 'read-only', approvalPolicy: 'never',
    networkAccessEnabled: false, webSearchMode: web ? 'live' : 'disabled', ...(model ? { model } : {}),
  };
}

const resultText = (item: Extract<ThreadItem, { type: 'mcp_tool_call' }>) =>
  item.error?.message ?? (item.result?.content ?? []).map(c => ('text' in c ? c.text : '')).join('');



/** One event of the Codex turn. Command, file change and (without web research) web search end the turn. New SDK types must be classified here. */
export function onCodexItem(
  item: ThreadItem,
  evType: 'item.started' | 'item.updated' | 'item.completed',
  state: { texts: Map<string, number>; tools: Set<string>; web?: boolean },
  emit: (ev: ChatEvent) => void,
  locale?: Locale,
): { abort?: string } {
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
    case 'command_execution': case 'file_change':
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
      const { codex, opts } = client(s.id, codexInstructions(s, web), web);
      const thread = s.codexThreadId ? codex.resumeThread(s.codexThreadId, opts) : codex.startThread(opts);
      const { events } = await thread.runStreamed(prompt, { signal: ac.signal });
      for await (const ev of events) {
        if (ev.type === 'thread.started') { s.codexThreadId = ev.thread_id; persist(s); continue; }
        if (ev.type === 'turn.failed') { failed = ev.error.message; continue; }
        if (ev.type === 'error') { failed = ev.message; continue; }
        if (ev.type === 'turn.completed') { const u = ev.usage; usage = { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cached_input_tokens, cacheWrite: u.cache_write_input_tokens }; continue; }
        if (ev.type !== 'item.started' && ev.type !== 'item.updated' && ev.type !== 'item.completed') continue;
        const stop = onCodexItem(ev.item, ev.type, { texts, tools, web }, emit, s.locale);
        if (stop.abort) { failed = stop.abort; ac.abort(); }
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

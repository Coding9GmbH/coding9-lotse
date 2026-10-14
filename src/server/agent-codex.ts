import 'server-only';
// Codex-Laufzeit (ChatGPT-Abo): gleiche Shop-Tools wie bei Claude, aber über einen MCP-Endpunkt von Lotse (/api/mcp/<chatId>).
import { Codex, type ThreadItem, type ThreadOptions } from '@openai/codex-sdk';
import type { ChatEvent } from '@/lib/protocol';
import { bindRoundToken, codexConfig, codexEnv, codexLoggedIn, mcpTokenFor } from './codex';
import type { PlatformKind } from '@/lib/platforms';
import { buildSystem } from './prompt';
import type { Locale } from '@/lib/i18n/locales';
import { persist, type Session } from './sessions';
import { messages } from '@/lib/i18n';
import type { RunEnd, RunUsage } from './agent';
import { getSettings, redact } from './settings';
import { errMsg } from './util';

// Ergänzung zum System-Prompt: Codex kennt sonst seine Rolle als Programmier-Agent
const CODEX_NOTE = `\n\n## Laufzeit
Du läufst in Lotse, nicht als Programmier-Assistent. Du hast ausschließlich die Werkzeuge des MCP-Servers „shop“ (z. B. search_products, draft_page, ask_user, propose_product_changes). Führe keine Befehle aus, lies oder schreibe keine Dateien und frage nicht nach solchen Rechten. Das ist hier technisch gesperrt.`;
const CODEX_WEB_NOTE = ' Zusätzlich darfst du die Websuche verwenden (Internetrecherche ist eingeschaltet).';

/** Interne Adresse, unter der der Codex-Prozess Lotse erreicht (gleicher Rechner/Container). */
const internalUrl = () => (process.env.LOTSE_INTERNAL_URL || `http://127.0.0.1:${process.env.PORT || 3333}`).replace(/\/$/, '');

function client(chatId: string, platform?: PlatformKind, locale?: Locale, web = false) {
  const cfg = codexConfig({ mcpUrl: `${internalUrl()}/api/mcp/${encodeURIComponent(chatId)}`, instructions: buildSystem(platform, locale, web) + CODEX_NOTE + (web ? CODEX_WEB_NOTE : ''), web });
  const codex = new Codex({ env: codexEnv({ LOTSE_MCP_TOKEN: mcpTokenFor(chatId) }), config: cfg.config, configOverrides: cfg.configOverrides });
  const opts = codexThreadOptions(cfg.workingDirectory, getSettings().ai.codexModel, web);
  return { codex, opts };
}

/** Thread-Optionen jedes Laufs. Sandbox nur lesend, kein Netz für Befehle, keine Freigabe-Rückfrage; Websuche nur mit `web` (Internetrecherche). */
export function codexThreadOptions(workingDirectory: string, model?: string, web = false): ThreadOptions {
  return {
    workingDirectory, skipGitRepoCheck: true, sandboxMode: 'read-only', approvalPolicy: 'never',
    networkAccessEnabled: false, webSearchMode: web ? 'live' : 'disabled', ...(model ? { model } : {}),
  };
}

const resultText = (item: Extract<ThreadItem, { type: 'mcp_tool_call' }>) =>
  item.error?.message ?? (item.result?.content ?? []).map(c => ('text' in c ? c.text : '')).join('');



/** Ein Ereignis der Codex-Runde. Befehl, Dateiänderung und (ohne Internetrecherche) Websuche beenden die Runde. Neue SDK-Typen müssen hier eingeordnet werden. */
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

/** Eine Chat-Runde mit Codex. Abbruch über `signal` (Client weg). Das MCP-Token gilt bis zum Ende, auch während einer Freigabe. */
export async function runCodex(s: Session, prompt: string, signal: AbortSignal, emit: (ev: ChatEvent) => void): Promise<RunEnd> {
  return bindRoundToken(s.id, async () => {
    const t = messages(s.locale).server;
    if (!codexLoggedIn()) return { error: t.codexNotLoggedIn };
    const ac = new AbortController();
    if (signal.aborted) ac.abort(); else signal.addEventListener('abort', () => ac.abort(), { once: true });
    const texts = new Map<string, number>(); // agent_message-ID → bereits gesendete Zeichen
    const tools = new Set<string>();
    let failed: string | null = null, usage: RunUsage | undefined;
    const model = getSettings().ai.codexModel || undefined, web = getSettings().scopes.web;
    try {
      const { codex, opts } = client(s.id, s.platform, s.locale, web);
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

/** Verbindungstest: kurze Runde ohne Werkzeuge. */
export async function pingCodex(): Promise<string> {
  return bindRoundToken('ping', async () => {
    if (!codexLoggedIn()) throw new Error('Nicht mit ChatGPT angemeldet. Zuerst „Mit ChatGPT anmelden“ (Einstellungen).');
    const { codex, opts } = client('ping');
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 90_000);
    try {
      const turn = await codex.startThread(opts).run('Antworte exakt mit dem Wort: OK', { signal: ac.signal });
      return turn.finalResponse;
    } finally { clearTimeout(t); }
  });
}

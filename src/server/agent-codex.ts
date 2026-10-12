import 'server-only';
// Codex-Laufzeit (ChatGPT-Abo): gleiche Shop-Tools wie bei Claude, aber über einen MCP-Endpunkt von Lotse (/api/mcp/<chatId>).
import { Codex, type ThreadItem, type ThreadOptions } from '@openai/codex-sdk';
import type { ChatEvent } from '@/lib/protocol';
import { codexConfig, codexEnv, codexLoggedIn, mcpTokenFor } from './codex';
import type { PlatformKind } from '@/lib/platforms';
import { buildSystem } from './prompt';
import { persist, type Session } from './sessions';
import type { RunEnd } from './agent';
import { getSettings, redact } from './settings';
import { errMsg } from './util';

// Ergänzung zum System-Prompt: Codex kennt sonst seine Rolle als Programmier-Agent
const CODEX_NOTE = `\n\n## Laufzeit
Du läufst in Lotse, nicht als Programmier-Assistent. Du hast ausschließlich die Werkzeuge des MCP-Servers „shop“ (z. B. search_products, draft_page, ask_user, propose_product_changes). Führe keine Befehle aus, lies oder schreibe keine Dateien und frage nicht nach solchen Rechten. Das ist hier technisch gesperrt. Antworte auf Deutsch.`;

/** Interne Adresse, unter der der Codex-Prozess Lotse erreicht (gleicher Rechner/Container). */
const internalUrl = () => (process.env.LOTSE_INTERNAL_URL || `http://127.0.0.1:${process.env.PORT || 3333}`).replace(/\/$/, '');

function client(chatId: string, platform?: PlatformKind) {
  const cfg = codexConfig({ mcpUrl: `${internalUrl()}/api/mcp/${encodeURIComponent(chatId)}`, instructions: buildSystem(platform) + CODEX_NOTE });
  const codex = new Codex({ env: codexEnv({ LOTSE_MCP_TOKEN: mcpTokenFor(chatId) }), config: cfg.config, configOverrides: cfg.configOverrides });
  const opts = codexThreadOptions(cfg.workingDirectory, getSettings().ai.codexModel);
  return { codex, opts };
}

/** Thread-Optionen jedes Laufs. Sandbox nur lesend, kein Netz, keine Websuche, keine Freigabe-Rückfrage. */
export function codexThreadOptions(workingDirectory: string, model?: string): ThreadOptions {
  return {
    workingDirectory, skipGitRepoCheck: true, sandboxMode: 'read-only', approvalPolicy: 'never',
    networkAccessEnabled: false, webSearchMode: 'disabled', ...(model ? { model } : {}),
  };
}

const resultText = (item: Extract<ThreadItem, { type: 'mcp_tool_call' }>) =>
  item.error?.message ?? (item.result?.content ?? []).map(c => ('text' in c ? c.text : '')).join('');

const CODEX_ABORT = 'Codex wollte ein gesperrtes Werkzeug verwenden (Befehl/Datei/Websuche). Die Runde wurde abgebrochen.';

/** Ein Ereignis der Codex-Runde. Befehl, Dateiänderung und Websuche beenden die Runde. Neue SDK-Typen müssen hier eingeordnet werden. */
export function onCodexItem(
  item: ThreadItem,
  evType: 'item.started' | 'item.updated' | 'item.completed',
  state: { texts: Map<string, number>; tools: Set<string> },
  emit: (ev: ChatEvent) => void,
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
    case 'command_execution': case 'file_change': case 'web_search':
      return { abort: CODEX_ABORT };
    case 'reasoning': case 'todo_list': case 'error':
      return {};
    default: {
      const uncovered: never = item;
      return uncovered;
    }
  }
}

/** Eine Chat-Runde mit Codex. Abbruch über `signal` (Client weg). */
export async function runCodex(s: Session, prompt: string, signal: AbortSignal, emit: (ev: ChatEvent) => void): Promise<RunEnd> {
  if (!codexLoggedIn()) return { error: 'Codex ist nicht mit ChatGPT angemeldet (Einstellungen → KI verbinden).' };
  const ac = new AbortController();
  if (signal.aborted) ac.abort(); else signal.addEventListener('abort', () => ac.abort(), { once: true });
  const texts = new Map<string, number>(); // agent_message-ID → bereits gesendete Zeichen
  const tools = new Set<string>();
  let failed: string | null = null;
  try {
    const { codex, opts } = client(s.id, s.platform);
    const thread = s.codexThreadId ? codex.resumeThread(s.codexThreadId, opts) : codex.startThread(opts);
    const { events } = await thread.runStreamed(prompt, { signal: ac.signal });
    for await (const ev of events) {
      if (ev.type === 'thread.started') { s.codexThreadId = ev.thread_id; persist(s); continue; }
      if (ev.type === 'turn.failed') { failed = ev.error.message; continue; }
      if (ev.type === 'error') { failed = ev.message; continue; }
      if (ev.type === 'turn.completed') continue;
      if (ev.type !== 'item.started' && ev.type !== 'item.updated' && ev.type !== 'item.completed') continue;
      const stop = onCodexItem(ev.item, ev.type, { texts, tools }, emit);
      if (stop.abort) { failed = stop.abort; ac.abort(); }
    }
    persist(s);
    return { error: failed };
  } catch (e) {
    persist(s);
    return { error: failed ?? (ac.signal.aborted ? 'Abgebrochen.' : redact(errMsg(e))) };
  }
}

/** Verbindungstest: kurze Runde ohne Werkzeuge. */
export async function pingCodex(): Promise<string> {
  if (!codexLoggedIn()) throw new Error('Nicht mit ChatGPT angemeldet. Zuerst „Mit ChatGPT anmelden“ (Einstellungen).');
  const { codex, opts } = client('ping');
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 90_000);
  try {
    const turn = await codex.startThread(opts).run('Antworte exakt mit dem Wort: OK', { signal: ac.signal });
    return turn.finalResponse;
  } finally { clearTimeout(t); }
}

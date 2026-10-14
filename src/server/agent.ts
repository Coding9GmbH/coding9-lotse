import 'server-only';
// AI run per chat message: Claude Agent SDK or Codex (ChatGPT subscription) with only our shop tools (optionally web search), events as NDJSON to the UI.
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ChatEvent, ChatRequest } from '@/lib/protocol';
import type { PageSpec } from './cms';
import { parsePartial } from './partial-json';
import { buildSystem } from './prompt';
import { getSession, noteUiLocale, persist, persistSoon } from './sessions';
import { messages } from '@/lib/i18n';
import { log } from './log';
import { aiEnv, getSettings, redact } from './settings';
import { allToolsFor, buildToolServer } from './tools';
import { getPlatform } from './platform';
import { targetHint } from './target-hint';
import { pingCodex, runCodex } from './agent-codex';
import type { Session } from './sessions';
import { errMsg } from './util';

// Save immediately (approvals, questions, drafts); all other history events batched (persistSoon), live-only events not at all
const PERSIST_ON = new Set(['draft', 'styleguide', 'approval', 'changeset', 'changeset_result', 'question']);
const LIVE_ONLY = new Set(['draft_partial', 'start', 'changeset_progress']);
/** Built-in web tools of the Agent SDK, only when web research is enabled (read-only) */
export const WEB_TOOLS = ['WebSearch', 'WebFetch'];

/** Preview of a tool result: same redaction as for Codex, at most 300 characters. */
export function previewToolResult(content: unknown): string {
  const txt = Array.isArray(content) ? content.map(c => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).join('') : String(content);
  return redact(txt).slice(0, 300);
}

/** Add an event to the history: drop live-only events, merge text, keep only the latest preview (HTML) of drafts. */
export function recordEvent(events: ChatEvent[], ev: ChatEvent) {
  const last = events.at(-1);
  if (LIVE_ONLY.has(ev.t)) return; // live only
  if (ev.t === 'text' && last?.t === 'text') { last.text += ev.text; return; }
  if (ev.t === 'draft') for (const e of events) if (e.t === 'draft') e.html = undefined; // the UI only uses the current preview anyway
  events.push({ ...ev });
}

/**
 * Starts a chat turn in the background. It is NOT tied to the connection: switching chats or reloading
 * only unsubscribes that listener; the turn keeps running (abort only via stopChat). Events go to all listeners.
 * Returns false if a turn is already running in this chat.
 */
export function startChat({ chatId, message, target, onboarding, locale }: ChatRequest): { started: boolean; done: Promise<void> } {
  const s = getSession(chatId);
  if (s.running) return { started: false, done: Promise.resolve() };
  const emit = (ev: ChatEvent) => {
    recordEvent(s.events, ev);
    if (PERSIST_ON.has(ev.t)) persist(s); else if (!LIVE_ONLY.has(ev.t)) persistSoon(s);
    for (const l of s.listeners) { try { l(ev); } catch { s.listeners.delete(l); } }
  };
  s.emit = emit;
  s.running = true;
  if (locale) { s.locale = locale; noteUiLocale(locale); }
  const ac = new AbortController();
  s.abort = ac;
  if (target && !onboarding) s.target = target;
  s.title ??= (onboarding ? messages(s.locale).server.onboardingTitle : message).slice(0, 70);
  s.events.push({ t: 'user', text: message }); persist(s);
  emit({ t: 'start' });

  const hint = onboarding ? '[ONBOARDING] Erstelle jetzt den Styleguide dieses Shops: 1) get_brand_signals (sieht sich Startseite, Kategorie- und Produktseiten an: Farben, Schriften, Buttons, Blockfolgen, Komponenten), 2) bei Bedarf read_page für eine typische Landingpage/Magazinseite sowie get_category/get_product/search_media für Tonalität und Bildstil, 3) Rollen der Farben ableiten (primary = Buttons/Links; Kontrast prüfen), Ansprache (Du/Sie) aus echten Texten bestimmen, 4) save_styleguide mit vollständigem Ergebnis – inklusive components (wie Buttons, Überschriften, Karten, Abschnitte im Shop wirklich aussehen) und existingBlocks (welche Blöcke/Elemente der Shop auf seinen Seiten verwendet und wofür, damit neue Seiten dieselben übernehmen), 5) in 3–4 Sätzen zusammenfassen und nach Korrekturen fragen, 6) danach EINMAL per ask_user nach festen Vorgaben für Texte fragen (z. B. Mindestlänge von SEO-Texten, Wörter die nie vorkommen, Schreibweisen, Besonderheiten einzelner Kategorien); jede genannte Vorgabe mit add_rule speichern (Bereich passend, bei Kategorie-Bezug mit categoryId). Ohne Vorgaben nichts speichern.' : targetHint(target, getPlatform(s.platform).capabilities);

  const prompt = hint ? `${hint}\n${message}` : message;
  const provider = getSettings().ai.provider, t0 = Date.now();
  log.info('Chat-Runde gestartet', { chatId, provider, platform: s.platform, ...(onboarding ? { onboarding: true } : {}) });
  const done = (async () => {
    let end: RunEnd = { error: null };
    try {
      end = provider === 'codex' ? await runCodex(s, prompt, ac.signal, emit) : await runClaude(s, prompt, ac, emit);
    } catch (e) {
      end = { error: errMsg(e) };
    } finally {
      // `done` only once the turn is really over: whoever fetches the history afterwards no longer sees the chat as running
      s.running = false; s.abort = null;
      const error = end.error ?? (ac.signal.aborted ? messages(s.locale).server.runCancelled : null);
      emit({ t: 'done', error, ...(end.cost !== undefined ? { cost: end.cost } : {}) });
      persist(s);
      log[error ? 'warn' : 'info']('Chat-Runde beendet', { chatId, provider, ms: Date.now() - t0, ...(end.model ? { model: end.model } : {}), ...(end.usage ? { usage: end.usage } : {}),
        ...(end.cost !== undefined ? { costUsd: end.cost } : {}), ...(ac.signal.aborted ? { aborted: true } : {}), ...(error ? { error } : {}) });
    }
  })();
  return { started: true, done };
}

/** Result of a turn; startChat sends the `done` event after the end. */
export interface RunEnd { error: string | null; cost?: number; model?: string; usage?: RunUsage }
/** Token usage of a turn (for the log only) */
export interface RunUsage { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; turns?: number }

/** Model(s) and token totals from modelUsage of the SDK result (all model calls of the turn, including internal ones) */
export function usageOf(modelUsage: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }> | undefined, turns?: number): Pick<RunEnd, 'model' | 'usage'> {
  const all = Object.entries(modelUsage ?? {}); if (!all.length) return turns ? { usage: { turns } } : {};
  const sum = (k: 'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens') => all.reduce((n, [, u]) => n + (u[k] || 0), 0);
  return { model: all.map(([m]) => m).join(','), usage: { input: sum('inputTokens'), output: sum('outputTokens'), cacheRead: sum('cacheReadInputTokens'), cacheWrite: sum('cacheCreationInputTokens'), ...(turns ? { turns } : {}) } };
}

/** Claude Agent SDK: in-process MCP server "shop", partial drafts live from the tool input stream. */
async function runClaude(s: Session, prompt: string, ac: AbortController, emit: (ev: ChatEvent) => void): Promise<RunEnd> {
  let end: RunEnd = { error: null };
  try {
    const web = getSettings().scopes.web; // web research (Einstellungen → KI-Zugriff)
    const allowed = [...allToolsFor(s.platform), ...(web ? WEB_TOOLS : [])]; // tools of this session's platform
    const q = query({
      prompt,
      options: {
        systemPrompt: buildSystem(s.platform, s.locale, web),
        model: getSettings().ai.model || undefined,
        env: aiEnv(), // AI process without SHOPWARE_*/OPENAI_* credentials
        resume: s.sdkSessionId ?? undefined,
        tools: web ? WEB_TOOLS : [],     // no file/shell tools: only the shop tools, web search/pages only when web research is enabled
        settingSources: [],              // do not load CLAUDE.md / user settings
        mcpServers: { shop: buildToolServer(s) },
        allowedTools: allowed,
        // Only our shop tools (+ web if enabled); writing never happens here but in the executor after approval in the UI
        canUseTool: async (tool, input) => (allowed.includes(tool) ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Nicht erlaubt.' }),
        includePartialMessages: true,
        maxTurns: 40,
        abortController: ac,
      },
    });

    const live: Record<number, { json: string; last: number; busy?: boolean }> = {}; // content-block index -> partial JSON of draft_page
    const pushPartial = async (blk: { json: string; busy?: boolean }) => {
      if (blk.busy) return; blk.busy = true;
      try { const spec = parsePartial(blk.json) as Partial<PageSpec> | null; if (spec?.sections?.length && s.renderDraft) emit({ t: 'draft_partial', html: await s.renderDraft(spec as PageSpec, true), name: spec.name, pageType: spec.type }); } catch {}
      blk.busy = false;
    };
    for await (const m of q) {
      if ('session_id' in m && m.session_id) s.sdkSessionId = m.session_id;
      if (m.type === 'stream_event') {
        const e = m.event;
        if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use' && e.content_block.name.endsWith('draft_page')) live[e.index] = { json: '', last: 0 };
        if (e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta' && live[e.index]) {
          const blk = live[e.index]; blk.json += e.delta.partial_json;
          if (Date.now() - blk.last > 400) { blk.last = Date.now(); void pushPartial(blk); }
        }
        if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') emit({ t: 'text', text: e.delta.text });
        if (e.type === 'content_block_start' && e.content_block?.type === 'text') emit({ t: 'text_start' });
      } else if (m.type === 'assistant') {
        for (const b of m.message.content) if (b.type === 'tool_use') emit({ t: 'tool', id: b.id, name: b.name.replace('mcp__shop__', ''), input: b.input });
      } else if (m.type === 'user' && Array.isArray(m.message?.content)) {
        for (const b of m.message.content) if (b.type === 'tool_result') {
          emit({ t: 'tool_result', id: b.tool_use_id, error: !!b.is_error, preview: previewToolResult(b.content) });
        }
      } else if (m.type === 'result') {
        end = { error: m.is_error ? (('result' in m ? m.result : '') || m.subtype) : null, cost: m.total_cost_usd, ...usageOf(m.modelUsage, m.num_turns) }; persist(s);
      }
    }
  } catch (e) {
    end = { error: errMsg(e) }; persist(s);
  }
  return end;
}

/** AI connection test (Einstellungen → Testen). */
export async function pingAi(): Promise<string> {
  if (getSettings().ai.provider === 'codex') return pingCodex();
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 60_000); let text = '';
  try {
    for await (const m of query({ prompt: 'Antworte exakt mit dem Wort: OK', options: { tools: [], settingSources: [], maxTurns: 1, env: aiEnv(), abortController: ac, systemPrompt: 'Antworte extrem kurz.' } })) {
      if (m.type === 'result') { clearTimeout(t); if (m.is_error) throw new Error(('result' in m ? m.result : '') || m.subtype); text = 'result' in m ? m.result : ''; }
    }
  } finally { clearTimeout(t); }
  return text;
}

import 'server-only';
// AI run per chat message: Claude Agent SDK or Codex (ChatGPT subscription) with only our shop tools (optionally web search), events as NDJSON to the UI.
import fs from 'node:fs';
import path from 'node:path';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import type { ChatEvent, ChatRequest } from '@/lib/protocol';
import type { PageSpec } from './cms';
import { parsePartial } from './partial-json';
import { buildSystem, codeSystemFor } from './prompt';
import { dataDir } from './db';
import { sandboxStatus } from './sandbox/env';
import { ensureAwake } from './sandbox/jobs';
import { getTask, markTurn } from './sandbox/tasks';
import { getSession, noteUiLocale, persist, persistSoon } from './sessions';
import { messages } from '@/lib/i18n';
import { log } from './log';
import { aiEnv, getSettings, redact } from './settings';
import { buildToolServer, toolsAllowedFor } from './tools';
import { getPlatform } from './platform';
import { targetHint } from './target-hint';
import { pingCodex, runCodex } from './agent-codex';
import type { Session } from './sessions';
import { errMsg } from './util';
import { budgetGate, recordTurn, releaseBudget, turnCost } from './usage';

// Save immediately (approvals, questions, drafts); all other history events batched (persistSoon), live-only events not at all
const PERSIST_ON = new Set(['draft', 'styleguide', 'approval', 'changeset', 'changeset_result', 'question', 'sandbox_status', 'publish_proposal']);
const LIVE_ONLY = new Set(['draft_partial', 'start', 'changeset_progress', 'preview_reload']);
/** Code chats: more steps per turn (explore, edit, compile, check, fix) than a shop turn */
export const CODE_MAX_TURNS = 120;
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
  if (ev.t === 'command') { const i = events.findLastIndex(e => e.t === 'command' && e.id === ev.id); if (i >= 0) { events[i] = { ...ev }; return; } } // only the command's last state
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
  const code = s.mode === 'code';
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
  if (target && !onboarding && !code) s.target = target;
  s.title ??= (code ? getTask(s.taskId ?? '')?.title ?? message : onboarding ? messages(s.locale).server.onboardingTitle : message).slice(0, 70);
  s.events.push({ t: 'user', text: message }); persist(s);
  emit({ t: 'start' });

  const hint = code ? '' : onboarding ? '[ONBOARDING] Erstelle jetzt den Styleguide dieses Shops: 1) get_brand_signals (sieht sich Startseite, Kategorie- und Produktseiten an: Farben, Schriften, Buttons, Blockfolgen, Komponenten), 2) bei Bedarf read_page für eine typische Landingpage/Magazinseite sowie get_category/get_product/search_media für Tonalität und Bildstil, 3) Rollen der Farben ableiten (primary = Buttons/Links; Kontrast prüfen), Ansprache (Du/Sie) aus echten Texten bestimmen, 4) save_styleguide mit vollständigem Ergebnis – inklusive components (wie Buttons, Überschriften, Karten, Abschnitte im Shop wirklich aussehen) und existingBlocks (welche Blöcke/Elemente der Shop auf seinen Seiten verwendet und wofür, damit neue Seiten dieselben übernehmen), 5) in 3–4 Sätzen zusammenfassen und nach Korrekturen fragen, 6) danach EINMAL per ask_user nach festen Vorgaben für Texte fragen (z. B. Mindestlänge von SEO-Texten, Wörter die nie vorkommen, Schreibweisen, Besonderheiten einzelner Kategorien); jede genannte Vorgabe mit add_rule speichern (Bereich passend, bei Kategorie-Bezug mit categoryId). Ohne Vorgaben nichts speichern.' : targetHint(target, getPlatform(s.platform).capabilities);

  const prompt = hint ? `${hint}\n${message}` : message;
  const provider = getSettings().ai.provider, t0 = Date.now();
  // Cost brake (usage.ts): Claude only (Codex = subscription without USD costs). Used-up budget → no turn; otherwise the remaining budget is the turn's limit
  const gate = provider === 'claude' ? budgetGate(new Date(), chatId) : { blocked: false as const };
  log.info('Chat-Runde gestartet', { chatId, provider, ...(code ? { task: s.taskId } : { platform: s.platform }), ...(onboarding ? { onboarding: true } : {}), ...(gate.blocked ? { budgetBlocked: true } : {}) });
  if (code && s.taskId) markTurn(s.taskId, true); // the idle sweeper leaves the container running meanwhile
  const done = (async () => {
    let end: RunEnd = { error: null }, cost: number | null = null;
    try {
      if (gate.blocked) { const usd = (n: number) => `${n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`; end = { error: messages(s.locale).server.budgetReached(usd(gate.spent), usd(gate.budget)) }; }
      else {
        const blocked = code ? await prepareCodeTurn(s, emit) : null; // code chat: Sandbox on, task ready, container awake
        end = blocked ? { error: blocked } : provider === 'codex' ? await runCodex(s, prompt, ac.signal, emit) : await runClaude(s, prompt, ac, emit, gate.maxUsd);
      }
    } catch (e) {
      end = { error: errMsg(e) };
    } finally {
      // `done` only once the turn is really over: whoever fetches the history afterwards no longer sees the chat as running
      s.running = false; s.abort = null;
      if (code && s.taskId) markTurn(s.taskId, false);
      if (!gate.blocked) {
        const t = turnCost(end, { total: s.costTotal ?? null, session: s.costSession ?? null }, s.sdkSessionId);
        cost = t.cost; s.costTotal = t.next.total; s.costSession = t.next.session;
        releaseBudget(chatId);
        recordTurn({ chatId, provider, model: end.model, cost, usage: end.usage });
      }
      const error = end.error ?? (ac.signal.aborted ? messages(s.locale).server.runCancelled : null);
      emit({ t: 'done', error, ...(cost != null ? { cost } : {}) });
      persist(s);
      log[error ? 'warn' : 'info']('Chat-Runde beendet', { chatId, provider, ms: Date.now() - t0, ...(end.model ? { model: end.model } : {}), ...(end.usage ? { usage: end.usage } : {}),
        ...(cost != null ? { costUsd: cost } : {}), ...(end.cost != null ? { costTotalUsd: end.cost } : {}), ...(ac.signal.aborted ? { aborted: true } : {}), ...(error ? { error } : {}) });
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

/** Empty working directory of Claude in code chats: never the task's workspace (files are reached only through the tools). */
export const claudeWorkDir = () => { const d = path.join(dataDir(), 'claude-work'); fs.mkdirSync(d, { recursive: true, mode: 0o700 }); return d; };

/**
 * Options of a Claude turn. No built-in file/shell tools (web search/pages only with web research), no CLAUDE.md/settings, only the
 * session's own tools: the shop tools of its platform, or in a code chat the workspace tools of its task (more turns, empty cwd).
 * Writing to the shop never happens here but in the executor after approval in the UI.
 */
export function claudeOptions(s: Session, o: { web: boolean; model?: string; maxUsd?: number; ac: AbortController }): Options {
  const code = s.mode === 'code';
  const allowed = [...toolsAllowedFor(s), ...(o.web ? WEB_TOOLS : [])];
  return {
    systemPrompt: code ? codeSystemFor(s.taskId, s.locale, o.web) : buildSystem(s.platform, s.locale, o.web),
    model: o.model,
    env: aiEnv(), // AI process without SHOPWARE_*/OPENAI_*/GitHub credentials
    ...(code ? { cwd: claudeWorkDir() } : {}),
    resume: s.sdkSessionId ?? undefined,
    tools: o.web ? WEB_TOOLS : [],
    settingSources: [],
    mcpServers: { shop: buildToolServer(s) },
    allowedTools: allowed,
    canUseTool: async (tool, input) => (allowed.includes(tool) ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Nicht erlaubt.' }),
    includePartialMessages: true,
    maxTurns: code ? CODE_MAX_TURNS : 40,
    ...(o.maxUsd ? { maxBudgetUsd: o.maxUsd } : {}),
    abortController: o.ac,
  };
}

/** Before a code turn: Sandbox Coding on, the task ready (or paused: woken now, the chat waits for Shopware). null = go; otherwise the message. */
export async function prepareCodeTurn(s: Session, emit: (ev: ChatEvent) => void): Promise<string | null> {
  const t = messages(s.locale).server;
  if (!sandboxStatus().enabled) return t.codeSandboxOff;
  const task = getTask(s.taskId ?? '');
  if (!task) return t.codeTaskGone;
  if (task.status === 'done') return t.codeTaskDone;
  if (!['ready', 'paused', 'waking'].includes(task.status)) return t.codeNotReady;
  const asleep = task.status !== 'ready' || !task.containerRunning;
  if (asleep) emit({ t: 'sandbox_status', state: 'waking' });
  try { await ensureAwake(task.id); } catch (e) {
    const msg = t.codeWakeFailed(redact(errMsg(e)).slice(0, 300));
    emit({ t: 'sandbox_status', state: 'failed', message: msg });
    return msg;
  }
  if (asleep) emit({ t: 'sandbox_status', state: 'ready' });
  return null;
}

/** Claude Agent SDK: in-process MCP server "shop", partial drafts live from the tool input stream. */
/** maxUsd: remaining monthly budget (cost brake); the SDK stops the turn with error_max_budget_usd once it is reached */
async function runClaude(s: Session, prompt: string, ac: AbortController, emit: (ev: ChatEvent) => void, maxUsd?: number): Promise<RunEnd> {
  let end: RunEnd = { error: null };
  try {
    const q = query({ prompt, options: claudeOptions(s, { web: getSettings().scopes.web, model: getSettings().ai.model || undefined, maxUsd, ac }) });

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
        const error = m.subtype === 'error_max_budget_usd' ? messages(s.locale).server.budgetTurnStopped : m.is_error ? (('result' in m ? m.result : '') || m.subtype) : null;
        end = { error, cost: m.total_cost_usd, ...usageOf(m.modelUsage, m.num_turns) }; persist(s);
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

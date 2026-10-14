import 'server-only';
// KI-Lauf je Chat-Nachricht: Claude Agent SDK oder Codex (ChatGPT-Abo) mit ausschließlich unseren Shop-Tools (optional Websuche), Ereignisse als NDJSON an die Oberfläche.
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

// Sofort speichern (Freigaben, Rückfragen, Entwürfe); alle übrigen Ereignisse des Verlaufs gebündelt (persistSoon), nur-live-Ereignisse gar nicht
const PERSIST_ON = new Set(['draft', 'styleguide', 'approval', 'changeset', 'changeset_result', 'question']);
const LIVE_ONLY = new Set(['draft_partial', 'start', 'changeset_progress']);
/** Eingebaute Web-Werkzeuge des Agent SDK, nur bei eingeschalteter Internetrecherche (nur lesend) */
export const WEB_TOOLS = ['WebSearch', 'WebFetch'];

/** Vorschau eines Werkzeugergebnisses: dieselbe Schwärzung wie bei Codex, höchstens 300 Zeichen. */
export function previewToolResult(content: unknown): string {
  const txt = Array.isArray(content) ? content.map(c => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).join('') : String(content);
  return redact(txt).slice(0, 300);
}

/** Ereignis in den Verlauf aufnehmen: nur-live-Ereignisse weglassen, Text zusammenfassen, von Entwürfen nur die letzte Vorschau (HTML) behalten. */
export function recordEvent(events: ChatEvent[], ev: ChatEvent) {
  const last = events.at(-1);
  if (LIVE_ONLY.has(ev.t)) return; // nur live
  if (ev.t === 'text' && last?.t === 'text') { last.text += ev.text; return; }
  if (ev.t === 'draft') for (const e of events) if (e.t === 'draft') e.html = undefined; // Oberfläche nutzt ohnehin nur die aktuelle Vorschau
  events.push({ ...ev });
}

/**
 * Startet eine Chat-Runde im Hintergrund. Sie hängt NICHT an der Verbindung: Wer den Chat wechselt oder neu lädt,
 * meldet nur seinen Listener ab; die Runde läuft weiter (Abbruch nur über stopChat). Ereignisse gehen an alle Listener.
 * Liefert false, wenn in diesem Chat schon eine Runde läuft.
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
      // `done` erst, wenn die Runde wirklich vorbei ist: Wer danach den Verlauf abruft, sieht den Chat nicht mehr als laufend
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

/** Ergebnis einer Runde; das `done`-Ereignis sendet startChat nach dem Ende. */
export interface RunEnd { error: string | null; cost?: number; model?: string; usage?: RunUsage }
/** Token-Verbrauch einer Runde (nur fürs Log) */
export interface RunUsage { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; turns?: number }

/** Modell(e) und Token-Summen aus modelUsage des SDK-Ergebnisses (alle Modellaufrufe der Runde, inkl. interner) */
export function usageOf(modelUsage: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }> | undefined, turns?: number): Pick<RunEnd, 'model' | 'usage'> {
  const all = Object.entries(modelUsage ?? {}); if (!all.length) return turns ? { usage: { turns } } : {};
  const sum = (k: 'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens') => all.reduce((n, [, u]) => n + (u[k] || 0), 0);
  return { model: all.map(([m]) => m).join(','), usage: { input: sum('inputTokens'), output: sum('outputTokens'), cacheRead: sum('cacheReadInputTokens'), cacheWrite: sum('cacheCreationInputTokens'), ...(turns ? { turns } : {}) } };
}

/** Claude Agent SDK: In-Process-MCP-Server „shop“, Teil-Entwürfe live aus dem Tool-Input-Stream. */
async function runClaude(s: Session, prompt: string, ac: AbortController, emit: (ev: ChatEvent) => void): Promise<RunEnd> {
  let end: RunEnd = { error: null };
  try {
    const web = getSettings().scopes.web; // Internetrecherche (Einstellungen → KI-Zugriff)
    const allowed = [...allToolsFor(s.platform), ...(web ? WEB_TOOLS : [])]; // Werkzeuge der Plattform dieser Session
    const q = query({
      prompt,
      options: {
        systemPrompt: buildSystem(s.platform, s.locale, web),
        model: getSettings().ai.model || undefined,
        env: aiEnv(), // KI-Prozess ohne SHOPWARE_*/OPENAI_*-Zugangsdaten
        resume: s.sdkSessionId ?? undefined,
        tools: web ? WEB_TOOLS : [],     // keine Datei-/Shell-Tools: nur die Shop-Tools, Websuche/Webseiten nur bei eingeschalteter Internetrecherche
        settingSources: [],              // keine CLAUDE.md / User-Settings laden
        mcpServers: { shop: buildToolServer(s) },
        allowedTools: allowed,
        // Nur unsere Shop-Tools (+ ggf. Web); das Schreiben passiert nie hier, sondern im Executor nach Freigabe im UI
        canUseTool: async (tool, input) => (allowed.includes(tool) ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Nicht erlaubt.' }),
        includePartialMessages: true,
        maxTurns: 40,
        abortController: ac,
      },
    });

    const live: Record<number, { json: string; last: number; busy?: boolean }> = {}; // content-block index -> Teil-JSON von draft_page
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

/** Verbindungstest der KI (Einstellungen → Testen). */
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

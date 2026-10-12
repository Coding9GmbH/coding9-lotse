import 'server-only';
// KI-Lauf je Chat-Nachricht: Claude Agent SDK oder Codex (ChatGPT-Abo) mit ausschließlich unseren Shop-Tools, Ereignisse als NDJSON an die Oberfläche.
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ChatEvent, ChatRequest } from '@/lib/protocol';
import type { PageSpec } from './cms';
import { parsePartial } from './partial-json';
import { buildSystem } from './prompt';
import { getSession, persist } from './sessions';
import { aiEnv, getSettings } from './settings';
import { allToolsFor, buildToolServer } from './tools';
import { getPlatform } from './platform';
import { targetHint } from './target-hint';
import { pingCodex, runCodex } from './agent-codex';
import type { Session } from './sessions';
import { errMsg } from './util';

const PERSIST_ON = new Set(['draft', 'styleguide', 'approval', 'changeset', 'changeset_result', 'question']);

/** Ereignis in den Verlauf aufnehmen: nur-live-Ereignisse weglassen, Text zusammenfassen, von Entwürfen nur die letzte Vorschau (HTML) behalten. */
export function recordEvent(events: ChatEvent[], ev: ChatEvent) {
  const last = events.at(-1);
  if (ev.t === 'draft_partial' || ev.t === 'start' || ev.t === 'changeset_progress') return; // nur live
  if (ev.t === 'text' && last?.t === 'text') { last.text += ev.text; return; }
  if (ev.t === 'draft') for (const e of events) if (e.t === 'draft') e.html = undefined; // Oberfläche nutzt ohnehin nur die aktuelle Vorschau
  events.push({ ...ev });
}

/**
 * Startet eine Chat-Runde im Hintergrund. Sie hängt NICHT an der Verbindung: Wer den Chat wechselt oder neu lädt,
 * meldet nur seinen Listener ab; die Runde läuft weiter (Abbruch nur über stopChat). Ereignisse gehen an alle Listener.
 * Liefert false, wenn in diesem Chat schon eine Runde läuft.
 */
export function startChat({ chatId, message, target, onboarding }: ChatRequest): { started: boolean; done: Promise<void> } {
  const s = getSession(chatId);
  if (s.running) return { started: false, done: Promise.resolve() };
  const emit = (ev: ChatEvent) => {
    recordEvent(s.events, ev);
    if (PERSIST_ON.has(ev.t)) persist(s);
    for (const l of s.listeners) { try { l(ev); } catch { s.listeners.delete(l); } }
  };
  s.emit = emit;
  s.running = true;
  const ac = new AbortController();
  s.abort = ac;
  if (target && !onboarding) s.target = target;
  s.title ??= (onboarding ? 'Styleguide-Onboarding' : message).slice(0, 70);
  s.events.push({ t: 'user', text: message }); persist(s);
  emit({ t: 'start' });

  const hint = onboarding ? '[ONBOARDING] Erstelle jetzt den Styleguide dieses Shops: 1) get_brand_signals (sieht sich Startseite, Kategorie- und Produktseiten an: Farben, Schriften, Buttons, Blockfolgen, Komponenten), 2) bei Bedarf read_page für eine typische Landingpage/Magazinseite sowie get_category/get_product/search_media für Tonalität und Bildstil, 3) Rollen der Farben ableiten (primary = Buttons/Links; Kontrast prüfen), Ansprache (Du/Sie) aus echten Texten bestimmen, 4) save_styleguide mit vollständigem Ergebnis – inklusive components (wie Buttons, Überschriften, Karten, Abschnitte im Shop wirklich aussehen) und existingBlocks (welche Blöcke/Elemente der Shop auf seinen Seiten verwendet und wofür, damit neue Seiten dieselben übernehmen), 5) in 3–4 Sätzen zusammenfassen und nach Korrekturen fragen.' : targetHint(target, getPlatform(s.platform).capabilities);

  const prompt = hint ? `${hint}\n${message}` : message;
  const done = (async () => {
    let end: RunEnd = { error: null };
    try {
      end = getSettings().ai.provider === 'codex' ? await runCodex(s, prompt, ac.signal, emit) : await runClaude(s, prompt, ac, emit);
    } catch (e) {
      end = { error: errMsg(e) };
    } finally {
      // `done` erst, wenn die Runde wirklich vorbei ist: Wer danach den Verlauf abruft, sieht den Chat nicht mehr als laufend
      s.running = false; s.abort = null;
      emit({ t: 'done', error: end.error ?? (ac.signal.aborted ? 'Abgebrochen.' : null), ...(end.cost !== undefined ? { cost: end.cost } : {}) });
      persist(s);
    }
  })();
  return { started: true, done };
}

/** Ergebnis einer Runde; das `done`-Ereignis sendet startChat nach dem Ende. */
export interface RunEnd { error: string | null; cost?: number }

/** Claude Agent SDK: In-Process-MCP-Server „shop“, Teil-Entwürfe live aus dem Tool-Input-Stream. */
async function runClaude(s: Session, prompt: string, ac: AbortController, emit: (ev: ChatEvent) => void): Promise<RunEnd> {
  let end: RunEnd = { error: null };
  try {
    const allowed = allToolsFor(s.platform); // Werkzeuge der Plattform dieser Session
    const q = query({
      prompt,
      options: {
        systemPrompt: buildSystem(s.platform),
        model: getSettings().ai.model || undefined,
        env: aiEnv(), // KI-Prozess ohne SHOPWARE_*/OPENAI_*-Zugangsdaten
        resume: s.sdkSessionId ?? undefined,
        tools: [],                       // keine Datei-/Shell-Tools: der Agent darf nur die Shop-Tools
        settingSources: [],              // keine CLAUDE.md / User-Settings laden
        mcpServers: { shop: buildToolServer(s) },
        allowedTools: allowed,
        // Nur unsere Shop-Tools; das Schreiben passiert nie hier, sondern im Executor nach Freigabe im UI
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
          const txt = Array.isArray(b.content) ? b.content.map(c => ('text' in c ? c.text : '')).join('') : String(b.content);
          emit({ t: 'tool_result', id: b.tool_use_id, error: !!b.is_error, preview: txt.slice(0, 300) });
        }
      } else if (m.type === 'result') {
        end = { error: m.is_error ? (('result' in m ? m.result : '') || m.subtype) : null, cost: m.total_cost_usd }; persist(s);
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

import 'server-only';
// Kleiner strukturierter Logger. LOTSE_LOG_FORMAT=json: eine JSON-Zeile je Eintrag (ts, level, msg, chatId, weitere Felder),
// sonst lesbar. LOTSE_LOG_LEVEL: debug | info (Standard) | warn | error | silent. warn/error gehen nach stderr, der Rest nach stdout.
// Geheimnisse: jeder Text läuft durch redact() (gespeicherte Zugangsdaten, Bearer-/sk-Tokens), Felder mit Geheimnis-Namen werden geschwärzt.
import { redact } from './settings';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface LogFields { chatId?: string; [k: string]: unknown }
const RANK: Record<LogLevel | 'silent', number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const SECRET_KEY = /pass(word)?|secret|token|api[-_]?key|authorization|cookie/i;

type Sink = (stream: 'stdout' | 'stderr', line: string) => void;
let sink: Sink | null = null;
/** Nur Tests: Ausgabe abfangen (null = wieder stdout/stderr). Ohne Sink schweigt der Logger unter node:test. */
export function setLogSinkForTests(s: Sink | null): void { sink = s; }

const threshold = () => { const l = (process.env.LOTSE_LOG_LEVEL ?? '').trim().toLowerCase(); return l in RANK ? RANK[l as LogLevel] : RANK.info; };
export const logEnabled = (level: LogLevel) => RANK[level] >= threshold();

// Schwärzung darf das Loggen nie verhindern (z. B. Einstellungen nicht lesbar): dann nur die Muster ohne gespeicherte Werte
const clean = (t: string) => { try { return redact(t); } catch { return t.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/g, 'Bearer •••').replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-•••'); } };
const replacer = (k: string, v: unknown) => {
  if (k && SECRET_KEY.test(k) && v != null && v !== '' && typeof v !== 'boolean' && typeof v !== 'number') return '•••';
  if (v instanceof Error) return clean(v.message);
  return typeof v === 'string' ? clean(v) : v;
};
const human = (v: unknown) => (typeof v === 'string' ? (/[\s"=]/.test(v) ? JSON.stringify(v) : v) : JSON.stringify(v));

/** Eine Zeile im gewählten Format (ohne Ausgabe; exportiert für Tests). */
export function formatLog(level: LogLevel, msg: string, fields: LogFields = {}, now = new Date()): string {
  const safe = JSON.parse(JSON.stringify({ msg, ...fields }, replacer) ?? '{}') as Record<string, unknown>;
  const { msg: m, ...rest } = safe;
  if (process.env.LOTSE_LOG_FORMAT === 'json') return JSON.stringify({ ts: now.toISOString(), level, msg: m, ...rest });
  const kv = Object.entries(rest).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${human(v)}`).join(' ');
  return `${now.toISOString()} ${level.toUpperCase().padEnd(5)} ${m}${kv ? ` ${kv}` : ''}`;
}

function write(level: LogLevel, msg: string, fields?: LogFields) {
  if (!logEnabled(level)) return;
  if (!sink && process.env.NODE_TEST_CONTEXT) return; // Testläufe nicht vollschreiben
  let line: string;
  try { line = formatLog(level, msg, fields); } catch { line = formatLog(level, msg); }
  const stream = level === 'warn' || level === 'error' ? 'stderr' : 'stdout';
  if (sink) sink(stream, line); else process[stream].write(line + '\n');
}

export const log = {
  debug: (msg: string, fields?: LogFields) => write('debug', msg, fields),
  info: (msg: string, fields?: LogFields) => write('info', msg, fields),
  warn: (msg: string, fields?: LogFields) => write('warn', msg, fields),
  error: (msg: string, fields?: LogFields) => write('error', msg, fields),
};

/** Pfad einer URL ohne Query (Tokens in Query-Parametern gehören nicht ins Log). */
export const urlForLog = (url: string) => { try { const u = new URL(url); return `${u.host}${u.pathname}`; } catch { return '?'; } };

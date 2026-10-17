import 'server-only';
// Local persistence (SQLite, node:sqlite) + encryption for credentials. Everything lives in the data folder (Docker: volume /data).
// No side effects on import: DB, folder and key are only created on first use (next build has no writable /data).
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CHAT_PAGE, type AccessLogRow, type AuditRow, type ChatEvent, type Target, type UndoOp } from '@/lib/protocol';
export { CHAT_PAGE };
import type { PageSpec } from './cms';
import { currentActor } from './actor';
import { singleton } from './state';

export const dataDir = () => path.resolve(/*turbopackIgnore: true*/ process.env.AICB_DATA || path.join(process.cwd(), 'data'));

const DB_FILE = 'aicb.db';
function open(): DatabaseSync {
  const dir = dataDir(), file = path.join(dir, DB_FILE);
  fs.mkdirSync(dir, { recursive: true });
  // Permissions 600 outside Docker too: create the file up front; SQLite creates -wal/-shm with the DB file's permissions
  try { fs.closeSync(fs.openSync(file, 'a', 0o600)); } catch {}
  const d = new DatabaseSync(file);
  d.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;'); // busy_timeout: a second process (backup snapshot, migration) waits instead of SQLITE_BUSY
  for (const f of [file, `${file}-wal`, `${file}-shm`]) try { fs.chmodSync(f, 0o600); } catch {} // fix up existing files from older versions
  runMigrations(d);
  d.exec('DELETE FROM changeset_runs WHERE chat_id NOT IN (SELECT id FROM chats);'); // run rows of deleted chats would never be found again (runsOpen starts from the chat)
  migrate(d);
  try { pruneLogsOn(d); } catch {} logPrune().at = Date.now(); // cleanup must never prevent startup
  return d;
}

// ---- Schema migrations (PRAGMA user_version) ----
// Order is a contract: only append, never reorder or change. Version n = the first n steps have run.
// Databases from older versions are at user_version 0 but already have the schema of step 1, which is why step 1 is idempotent.
const hasColumn = (d: DatabaseSync, table: string, col: string) => (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(c => c.name === col);
export const MIGRATIONS: ((d: DatabaseSync) => void)[] = [
  /* 1: base schema (up to 0.4.x without version number) */ d => d.exec(`
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, title TEXT, target TEXT, created_at TEXT, updated_at TEXT, published INTEGER DEFAULT 0, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS access_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, chat TEXT, op TEXT, entity TEXT, n INTEGER, scrubbed INTEGER DEFAULT 0, denied TEXT);
    CREATE TABLE IF NOT EXISTS changeset_runs (cs_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, json TEXT NOT NULL);`),
  /* 2: indexes for cleanup (ts), accesses per chat and chat list (paging by updated_at,id) */ d => d.exec(`
    CREATE INDEX IF NOT EXISTS access_log_ts ON access_log(ts);
    CREATE INDEX IF NOT EXISTS access_log_chat ON access_log(chat);
    CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts);
    CREATE INDEX IF NOT EXISTS chats_updated ON chats(updated_at DESC, id DESC);`),
  /* 3: who applied/undid (login user name, otherwise NULL) */ d => { if (!hasColumn(d, 'audit', 'actor')) d.exec('ALTER TABLE audit ADD COLUMN actor TEXT'); },
  /* 4: AI cost per chat turn (cost brake, usage.ts) */ d => d.exec(`
    CREATE TABLE IF NOT EXISTS ai_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, chat_id TEXT, provider TEXT NOT NULL, model TEXT, cost_usd REAL, input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER);
    CREATE INDEX IF NOT EXISTS ai_usage_ts ON ai_usage(ts);`),
];
export const schemaVersion = (d: DatabaseSync) => (d.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
export function runMigrations(d: DatabaseSync) {
  // Newer DB (downgrade): touch nothing, the old app doesn't know the later steps
  for (let v = schemaVersion(d); v < MIGRATIONS.length; v++) {
    d.exec('BEGIN IMMEDIATE');
    try { MIGRATIONS[v](d); d.exec(`PRAGMA user_version = ${v + 1}`); d.exec('COMMIT'); }
    catch (e) { d.exec('ROLLBACK'); throw e; }
  }
}
const db = () => singleton('db', open);

// ---- Key-Value ----
const kvGetOn = <T>(d: DatabaseSync, key: string): T | null => { const r = d.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined; return r ? (JSON.parse(r.value) as T) : null; };
const kvSetOn = (d: DatabaseSync, key: string, value: unknown) => { d.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value)); };
export const kvGet = <T = unknown>(key: string): T | null => kvGetOn<T>(db(), key);
export const kvSet = (key: string, value: unknown) => kvSetOn(db(), key, value);

// ---- Chats ----
/** Event in the saved history (older versions still had 'published'/'approval'). */
export type StoredEvent = ChatEvent;
export interface StoredChat {
  id: string; title: string | null; target: Target | null; createdAt: string; updatedAt: string;
  sdkSessionId: string | null; costTotal?: number | null; codexThreadId?: string | null; draft: PageSpec | null; events: StoredEvent[];
}
const evType = (e: StoredEvent) => (e as { t: string }).t;
function chatPutOn(d: DatabaseSync, c: StoredChat) {
  const published = c.events.filter(e => e.t === 'changeset_result' && e.status === 'applied' && e.published).length + c.events.filter(e => evType(e) === 'published').length;
  d.prepare(`INSERT INTO chats (id, title, target, created_at, updated_at, published, json) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title = excluded.title, target = excluded.target, updated_at = excluded.updated_at, published = excluded.published, json = excluded.json`)
    .run(c.id, c.title ?? '', JSON.stringify(c.target ?? null), c.createdAt, c.updatedAt, published, JSON.stringify(c));
}
export const chatGet = (id: string): StoredChat | null => { const r = db().prepare('SELECT json FROM chats WHERE id = ?').get(id) as { json: string } | undefined; return r ? (JSON.parse(r.json) as StoredChat) : null; };
export const chatPut = (c: StoredChat) => chatPutOn(db(), c);
interface ChatListRow { id: string; title: string; target: string; updated_at: string; published: number }
/** Paging: cursor = last row of the previous page (updated_at, id); q searches the title. Without options: the newest 200 as before. */
export interface ChatListOpts { limit?: number; before?: { updatedAt: string; id: string } | null; q?: string | null }
export function chatList({ limit = CHAT_PAGE, before = null, q = null }: ChatListOpts = {}) {
  const where: string[] = [], args: (string | number)[] = [], term = q?.trim();
  if (before) { where.push('(updated_at < ? OR (updated_at = ? AND id < ?))'); args.push(before.updatedAt, before.updatedAt, before.id); }
  if (term) { where.push("title LIKE ? ESCAPE '\\'"); args.push(`%${term.replace(/[\\%_]/g, c => '\\' + c)}%`); }
  const sql = `SELECT id, title, target, updated_at, published FROM chats ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC, id DESC LIMIT ?`;
  return (db().prepare(sql).all(...args, Math.max(1, Math.min(CHAT_PAGE, Math.floor(limit) || CHAT_PAGE))) as unknown as ChatListRow[])
    .map(r => ({ id: r.id, title: r.title, target: JSON.parse(r.target) as Target | null, updatedAt: r.updated_at, published: r.published }));
}
export const chatDelete = (id: string) => { db().prepare('DELETE FROM chats WHERE id = ?').run(id); db().prepare('DELETE FROM changeset_runs WHERE chat_id = ?').run(id); };

// ---- Running applies (crash safety) ----
// The row is created before the first write, updated piecemeal with results and undo steps while applying
// and only deleted once the result is saved in the chat. After a restart, "row exists" means: interrupted.
// total: selected items; results shorter than total = not all counted (after a crash the rest is unknown, not "not written")
export interface ChangeRun { csId: string; chatId: string; kind: string; title: string; startedAt: string; total?: number; results: { itemId: string; ok: boolean; error?: string }[]; undo: UndoOp[] }
export const runPut = (r: ChangeRun) => { db().prepare('INSERT INTO changeset_runs (cs_id, chat_id, json) VALUES (?, ?, ?) ON CONFLICT(cs_id) DO UPDATE SET json = excluded.json').run(r.csId, r.chatId, JSON.stringify(r)); };
export const runsOpen = (chatId: string): ChangeRun[] => (db().prepare('SELECT json FROM changeset_runs WHERE chat_id = ?').all(chatId) as unknown as { json: string }[]).map(r => JSON.parse(r.json) as ChangeRun);
export const runDelete = (csId: string) => { db().prepare('DELETE FROM changeset_runs WHERE cs_id = ?').run(csId); };

// ---- Audit (only writes after approval) & access log (what the AI has read) ----
/** actor: login user name (LOTSE_PASSWORD) or NULL; if omitted, taken from the request context (./actor). */
export const auditAdd = (entry: Record<string, unknown>, actor: string | null = currentActor(entry.chatId)) => { maybePrune(); db().prepare('INSERT INTO audit (ts, json, actor) VALUES (?, ?, ?)').run(new Date().toISOString(), JSON.stringify(entry), actor); };
export const auditList = (limit = 100): AuditRow[] => (db().prepare('SELECT ts, json, actor FROM audit ORDER BY id DESC LIMIT ?').all(limit) as unknown as { ts: string; json: string; actor: string | null }[])
  .map(r => ({ ts: r.ts, ...JSON.parse(r.json), ...(r.actor ? { actor: r.actor } : {}) }));
export interface AccessEntry { chat?: string | null; op: string; entity: string; n?: number; scrubbed?: number; denied?: string | null }
export const accessAdd = (a: AccessEntry) => { maybePrune(); db().prepare('INSERT INTO access_log (ts, chat, op, entity, n, scrubbed, denied) VALUES (?, ?, ?, ?, ?, ?, ?)').run(new Date().toISOString(), a.chat ?? null, a.op, a.entity, a.n ?? 0, a.scrubbed ?? 0, a.denied ?? null); };
export const accessList = (limit = 100) => db().prepare('SELECT ts, chat, op, entity, n, scrubbed, denied FROM access_log ORDER BY id DESC LIMIT ?').all(limit) as unknown as AccessLogRow[];

// ---- AI usage per chat turn (cost brake): cost_usd = cost of this turn (Claude), NULL if unknown (Codex subscription) ----
export interface UsageEntry { chatId?: string | null; provider: string; model?: string | null; costUsd?: number | null; input?: number; output?: number; cacheRead?: number; cacheWrite?: number; ts?: string }
export const usageAdd = (u: UsageEntry) => { db().prepare('INSERT INTO ai_usage (ts, chat_id, provider, model, cost_usd, input, output, cache_read, cache_write) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  .run(u.ts ?? new Date().toISOString(), u.chatId ?? null, u.provider, u.model ?? null, u.costUsd ?? null, u.input ?? null, u.output ?? null, u.cacheRead ?? null, u.cacheWrite ?? null); };
/** Sum since `from` (ISO), optionally per provider */
export function usageSince(from: string, provider?: string): { cost: number; turns: number } {
  const r = db().prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS cost, COUNT(*) AS turns FROM ai_usage WHERE ts >= ?${provider ? ' AND provider = ?' : ''}`).get(...(provider ? [from, provider] : [from])) as { cost: number; turns: number };
  return { cost: Number(r.cost) || 0, turns: Number(r.turns) || 0 };
}
/** Cost per UTC day since `from` (only days with turns) */
export const usageByDay = (from: string) => (db().prepare("SELECT substr(ts, 1, 10) AS day, COALESCE(SUM(cost_usd), 0) AS cost, COUNT(*) AS turns FROM ai_usage WHERE ts >= ? GROUP BY day ORDER BY day").all(from) as unknown as { day: string; cost: number; turns: number }[]);

// ---- Retention: delete old log rows (at startup and then at most once a day, on the next write) ----
// LOTSE_LOG_RETENTION_DAYS (access log, default 180) and LOTSE_AUDIT_RETENTION_DAYS (change log, default 365, minimum 30).
// 0 = never delete. Undo doesn't need the audit (previous values are in the chat); still, entries of chats with an open run are kept.
const DAY = 86_400_000, USAGE_DAYS = 400;
const days = (v: string | undefined, def: number, min = 1) => { const n = v == null || v.trim() === '' ? def : Number(v); return !Number.isFinite(n) || n < 0 ? def : n === 0 ? 0 : Math.max(min, Math.floor(n)); };
export const retention = () => ({ access: days(process.env.LOTSE_LOG_RETENTION_DAYS, 180), audit: days(process.env.LOTSE_AUDIT_RETENTION_DAYS, 365, 30) });
const logPrune = () => singleton('logPrune', () => ({ at: 0 }));
export function pruneLogsOn(d: DatabaseSync, now = Date.now()): { access: number; audit: number } {
  const r = retention(), cut = (n: number) => new Date(now - n * DAY).toISOString();
  const access = r.access ? Number(d.prepare('DELETE FROM access_log WHERE ts < ?').run(cut(r.access)).changes) : 0;
  const audit = r.audit ? Number(d.prepare("DELETE FROM audit WHERE ts < ? AND COALESCE(CASE WHEN json_valid(json) THEN json_extract(json, '$.chatId') END, '') NOT IN (SELECT chat_id FROM changeset_runs)").run(cut(r.audit)).changes) : 0;
  d.prepare('DELETE FROM ai_usage WHERE ts < ?').run(cut(USAGE_DAYS)); // cost history: enough for this and last year's months
  return { access, audit };
}
export const pruneLogs = (now = Date.now()) => { logPrune().at = now; return pruneLogsOn(db(), now); };
function maybePrune(now = Date.now()) { if (now - logPrune().at >= DAY) try { pruneLogs(now); } catch {} }

// ---- Store secrets encrypted (AES-256-GCM, key in the data folder, permissions 600) ----
const KEY_LEN = 32;
/** Existing key must be exactly 32 bytes; otherwise fail clearly here instead of an opaque "Invalid key length" in seal() later */
function checkedKey(k: Buffer, keyfile: string): Buffer {
  if (k.length !== KEY_LEN) throw new Error(`${keyfile} ist beschädigt (${k.length} statt ${KEY_LEN} Bytes). Datei aus einem Backup wiederherstellen; ohne den richtigen Schlüssel lassen sich gespeicherte Zugangsdaten nicht mehr entschlüsseln.`);
  return k;
}
const key = () => singleton('secretKey', (): Buffer => {
  const dir = dataDir(), keyfile = path.join(dir, 'secret.key');
  try { return checkedKey(fs.readFileSync(keyfile), keyfile); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  fs.mkdirSync(dir, { recursive: true });
  const k = crypto.randomBytes(KEY_LEN);
  // wx: never overwrite; if another process created the key in the meantime, use its key
  try { fs.writeFileSync(keyfile, k, { flag: 'wx', mode: 0o600 }); return k; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; return checkedKey(fs.readFileSync(keyfile), keyfile); }
});
const unsealWarned = () => singleton('unsealWarned', () => ({ done: false }));
/** Undecryptable secret (key replaced/lost, value corrupted): log once per process. Lazy import: log → settings → db would be a cycle. */
function warnUnseal(e: unknown) {
  const w = unsealWarned(); if (w.done) return; w.done = true;
  void import('./log').then(({ log }) => log.warn('Gespeicherter geheimer Wert lässt sich nicht entschlüsseln (secret.key ersetzt oder Wert beschädigt); er wird als leer behandelt', { error: e instanceof Error ? e.message : String(e) })).catch(() => {});
}
export function seal(text: unknown): string | null {
  if (text == null || text === '') return null;
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv), ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return 'enc:v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
export function unseal(s: string | null | undefined): string | null {
  if (!s) return null; if (!s.startsWith('enc:v1:')) return s;
  try { const b = Buffer.from(s.slice(7), 'base64'), d = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'); } catch (e) { warnUnseal(e); return null; }
}

// ---- One-time import of old JSON files (earlier versions) ----
function migrate(d: DatabaseSync) {
  if (kvGetOn(d, 'migrated_v1')) return;
  const dir = dataDir();
  try {
    const cdir = path.join(dir, 'chats');
    if (fs.existsSync(cdir)) for (const f of fs.readdirSync(cdir).filter(f => f.endsWith('.json'))) { try { chatPutOn(d, JSON.parse(fs.readFileSync(path.join(cdir, f), 'utf8'))); } catch {} }
    const sgf = path.join(dir, 'styleguide.json'); if (fs.existsSync(sgf) && !kvGetOn(d, 'styleguide')) kvSetOn(d, 'styleguide', JSON.parse(fs.readFileSync(sgf, 'utf8')));
    const af = path.join(dir, 'audit.jsonl'); if (fs.existsSync(af)) for (const l of fs.readFileSync(af, 'utf8').split('\n').filter(Boolean)) { try { const { ts, ...rest } = JSON.parse(l); d.prepare('INSERT INTO audit (ts, json) VALUES (?, ?)').run(ts, JSON.stringify(rest)); } catch {} }
    const mf = path.join(dir, 'staging', 'map.json'); if (fs.existsSync(mf)) kvSetOn(d, 'staging_map', JSON.parse(fs.readFileSync(mf, 'utf8')));
  } catch {}
  kvSetOn(d, 'migrated_v1', true);
}

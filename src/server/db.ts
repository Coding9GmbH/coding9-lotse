import 'server-only';
// Lokale Persistenz (SQLite, node:sqlite) + Verschlüsselung für Zugangsdaten. Alles liegt im Datenordner (Docker: Volume /data).
// Keine Seiteneffekte beim Import: DB, Ordner und Schlüssel entstehen erst bei der ersten Nutzung (next build hat kein beschreibbares /data).
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
  // Rechte 600 auch außerhalb von Docker: Datei vorab anlegen; SQLite legt -wal/-shm mit den Rechten der DB-Datei an
  try { fs.closeSync(fs.openSync(file, 'a', 0o600)); } catch {}
  const d = new DatabaseSync(file);
  d.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;'); // busy_timeout: zweiter Prozess (Backup-Schnappschuss, Migration) wartet statt SQLITE_BUSY
  for (const f of [file, `${file}-wal`, `${file}-shm`]) try { fs.chmodSync(f, 0o600); } catch {} // bestehende Dateien älterer Versionen nachziehen
  runMigrations(d);
  d.exec('DELETE FROM changeset_runs WHERE chat_id NOT IN (SELECT id FROM chats);'); // Lauf-Zeilen gelöschter Chats fände niemand mehr (runsOpen geht vom Chat aus)
  migrate(d);
  try { pruneLogsOn(d); } catch {} logPrune().at = Date.now(); // Aufräumen darf den Start nie verhindern
  return d;
}

// ---- Schema-Migrationen (PRAGMA user_version) ----
// Reihenfolge ist Vertrag: nur anhängen, nie umsortieren oder ändern. Version n = die ersten n Schritte sind gelaufen.
// Datenbanken älterer Versionen stehen auf user_version 0, haben aber schon das Schema von Schritt 1 – darum ist Schritt 1 idempotent.
const hasColumn = (d: DatabaseSync, table: string, col: string) => (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(c => c.name === col);
export const MIGRATIONS: ((d: DatabaseSync) => void)[] = [
  /* 1: Grundschema (bis 0.4.x ohne Versionsnummer) */ d => d.exec(`
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, title TEXT, target TEXT, created_at TEXT, updated_at TEXT, published INTEGER DEFAULT 0, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS access_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, chat TEXT, op TEXT, entity TEXT, n INTEGER, scrubbed INTEGER DEFAULT 0, denied TEXT);
    CREATE TABLE IF NOT EXISTS changeset_runs (cs_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, json TEXT NOT NULL);`),
  /* 2: Indizes für Aufräumen (ts), Zugriffe je Chat und Chatliste (Blättern nach updated_at,id) */ d => d.exec(`
    CREATE INDEX IF NOT EXISTS access_log_ts ON access_log(ts);
    CREATE INDEX IF NOT EXISTS access_log_chat ON access_log(chat);
    CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts);
    CREATE INDEX IF NOT EXISTS chats_updated ON chats(updated_at DESC, id DESC);`),
  /* 3: wer angewendet/rückgängig gemacht hat (Benutzername des Logins, sonst NULL) */ d => { if (!hasColumn(d, 'audit', 'actor')) d.exec('ALTER TABLE audit ADD COLUMN actor TEXT'); },
];
export const schemaVersion = (d: DatabaseSync) => (d.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
export function runMigrations(d: DatabaseSync) {
  // Neuere DB (Downgrade): nichts anfassen, die alte App kennt die späteren Schritte nicht
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
/** Ereignis im gespeicherten Verlauf (ältere Versionen kannten noch 'published'/'approval'). */
export type StoredEvent = ChatEvent;
export interface StoredChat {
  id: string; title: string | null; target: Target | null; createdAt: string; updatedAt: string;
  sdkSessionId: string | null; codexThreadId?: string | null; draft: PageSpec | null; events: StoredEvent[];
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
/** Blättern: Cursor = letzte Zeile der vorigen Seite (updated_at, id); q sucht im Titel. Ohne Optionen: die neuesten 200 wie bisher. */
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

// ---- Laufende Anwendungen (Absturzsicherheit) ----
// Die Zeile entsteht vor dem ersten Schreibzugriff, wird während des Anwendens häppchenweise mit Ergebnissen und Rückgängig-Schritten
// aktualisiert und erst gelöscht, wenn das Ergebnis im Chat gespeichert ist. Nach einem Neustart heißt „Zeile vorhanden“: unterbrochen.
// total: gewählte Elemente; results kürzer als total = nicht alle gezählt (der Rest ist nach einem Absturz unbekannt, nicht „nicht geschrieben“)
export interface ChangeRun { csId: string; chatId: string; kind: string; title: string; startedAt: string; total?: number; results: { itemId: string; ok: boolean; error?: string }[]; undo: UndoOp[] }
export const runPut = (r: ChangeRun) => { db().prepare('INSERT INTO changeset_runs (cs_id, chat_id, json) VALUES (?, ?, ?) ON CONFLICT(cs_id) DO UPDATE SET json = excluded.json').run(r.csId, r.chatId, JSON.stringify(r)); };
export const runsOpen = (chatId: string): ChangeRun[] => (db().prepare('SELECT json FROM changeset_runs WHERE chat_id = ?').all(chatId) as unknown as { json: string }[]).map(r => JSON.parse(r.json) as ChangeRun);
export const runDelete = (csId: string) => { db().prepare('DELETE FROM changeset_runs WHERE cs_id = ?').run(csId); };

// ---- Audit (nur Schreibvorgänge nach Freigabe) & Zugriffsprotokoll (was die KI gelesen hat) ----
/** actor: Benutzername des Logins (LOTSE_PASSWORD) oder NULL; ohne Angabe aus dem Anfrage-Kontext (./actor). */
export const auditAdd = (entry: Record<string, unknown>, actor: string | null = currentActor(entry.chatId)) => { maybePrune(); db().prepare('INSERT INTO audit (ts, json, actor) VALUES (?, ?, ?)').run(new Date().toISOString(), JSON.stringify(entry), actor); };
export const auditList = (limit = 100): AuditRow[] => (db().prepare('SELECT ts, json, actor FROM audit ORDER BY id DESC LIMIT ?').all(limit) as unknown as { ts: string; json: string; actor: string | null }[])
  .map(r => ({ ts: r.ts, ...JSON.parse(r.json), ...(r.actor ? { actor: r.actor } : {}) }));
export interface AccessEntry { chat?: string | null; op: string; entity: string; n?: number; scrubbed?: number; denied?: string | null }
export const accessAdd = (a: AccessEntry) => { maybePrune(); db().prepare('INSERT INTO access_log (ts, chat, op, entity, n, scrubbed, denied) VALUES (?, ?, ?, ?, ?, ?, ?)').run(new Date().toISOString(), a.chat ?? null, a.op, a.entity, a.n ?? 0, a.scrubbed ?? 0, a.denied ?? null); };
export const accessList = (limit = 100) => db().prepare('SELECT ts, chat, op, entity, n, scrubbed, denied FROM access_log ORDER BY id DESC LIMIT ?').all(limit) as unknown as AccessLogRow[];

// ---- Aufbewahrung: alte Protokollzeilen löschen (beim Start und danach höchstens einmal am Tag, beim nächsten Schreiben) ----
// LOTSE_LOG_RETENTION_DAYS (Zugriffsprotokoll, Standard 180) und LOTSE_AUDIT_RETENTION_DAYS (Änderungsprotokoll, Standard 365, mindestens 30).
// 0 = nie löschen. Rückgängig braucht das Audit nicht (Vorher-Werte stehen im Chat); trotzdem bleiben Einträge von Chats mit offenem Lauf stehen.
const DAY = 86_400_000;
const days = (v: string | undefined, def: number, min = 1) => { const n = v == null || v.trim() === '' ? def : Number(v); return !Number.isFinite(n) || n < 0 ? def : n === 0 ? 0 : Math.max(min, Math.floor(n)); };
export const retention = () => ({ access: days(process.env.LOTSE_LOG_RETENTION_DAYS, 180), audit: days(process.env.LOTSE_AUDIT_RETENTION_DAYS, 365, 30) });
const logPrune = () => singleton('logPrune', () => ({ at: 0 }));
export function pruneLogsOn(d: DatabaseSync, now = Date.now()): { access: number; audit: number } {
  const r = retention(), cut = (n: number) => new Date(now - n * DAY).toISOString();
  const access = r.access ? Number(d.prepare('DELETE FROM access_log WHERE ts < ?').run(cut(r.access)).changes) : 0;
  const audit = r.audit ? Number(d.prepare("DELETE FROM audit WHERE ts < ? AND COALESCE(CASE WHEN json_valid(json) THEN json_extract(json, '$.chatId') END, '') NOT IN (SELECT chat_id FROM changeset_runs)").run(cut(r.audit)).changes) : 0;
  return { access, audit };
}
export const pruneLogs = (now = Date.now()) => { logPrune().at = now; return pruneLogsOn(db(), now); };
function maybePrune(now = Date.now()) { if (now - logPrune().at >= DAY) try { pruneLogs(now); } catch {} }

// ---- Geheimnisse verschlüsselt ablegen (AES-256-GCM, Schlüssel im Datenordner, Rechte 600) ----
const key = () => singleton('secretKey', (): Buffer => {
  const dir = dataDir(), keyfile = path.join(dir, 'secret.key');
  try { return fs.readFileSync(keyfile); } catch { fs.mkdirSync(dir, { recursive: true }); const k = crypto.randomBytes(32); fs.writeFileSync(keyfile, k, { mode: 0o600 }); return k; }
});
export function seal(text: unknown): string | null {
  if (text == null || text === '') return null;
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv), ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return 'enc:v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
export function unseal(s: string | null | undefined): string | null {
  if (!s) return null; if (!s.startsWith('enc:v1:')) return s;
  try { const b = Buffer.from(s.slice(7), 'base64'), d = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'); } catch { return null; }
}

// ---- Einmalige Übernahme alter JSON-Dateien (frühere Versionen) ----
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

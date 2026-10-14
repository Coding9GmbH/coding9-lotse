import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Bestandsdaten: eine DB im Schema bis 0.4.x (ohne user_version, Rechte 644) plus alte JSON-Dateien (vor migrated_v1).
// Nach dem Update muss alles lesbar bleiben, die Migrationen laufen genau einmal, die Dateien haben danach Rechte 600.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-db-'));
process.env.AICB_DATA = dir;
delete process.env.LOTSE_LOG_RETENTION_DAYS; delete process.env.LOTSE_AUDIT_RETENTION_DAYS; delete process.env.LOTSE_PASSWORD;
const old = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
{
  const d = new DatabaseSync(path.join(dir, 'aicb.db'));
  d.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE chats (id TEXT PRIMARY KEY, title TEXT, target TEXT, created_at TEXT, updated_at TEXT, published INTEGER DEFAULT 0, json TEXT NOT NULL);
    CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE access_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, chat TEXT, op TEXT, entity TEXT, n INTEGER, scrubbed INTEGER DEFAULT 0, denied TEXT);
    CREATE TABLE changeset_runs (cs_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, json TEXT NOT NULL);`);
  const chat = (id: string, updatedAt: string, title = id) => d.prepare('INSERT INTO chats VALUES (?, ?, ?, ?, ?, 0, ?)').run(id, title, 'null', updatedAt, updatedAt, JSON.stringify({ id, title, target: null, createdAt: updatedAt, updatedAt, sdkSessionId: null, draft: null, events: [] }));
  chat('alt', '2025-01-01T00:00:00.000Z', 'Bestandschat');
  d.prepare('INSERT INTO audit (ts, json) VALUES (?, ?)').run(old(10), JSON.stringify({ chatId: 'alt', decision: 'approved', title: 'Bestand' }));
  d.prepare('INSERT INTO access_log (ts, op, entity) VALUES (?, ?, ?)').run(old(10), 'search', 'product');
  d.close();
  fs.chmodSync(path.join(dir, 'aicb.db'), 0o644);
  fs.mkdirSync(path.join(dir, 'chats'));
  fs.writeFileSync(path.join(dir, 'chats', 'json1.json'), JSON.stringify({ id: 'json1', title: 'Aus JSON', target: null, createdAt: '2024-05-01T00:00:00.000Z', updatedAt: '2024-05-01T00:00:00.000Z', sdkSessionId: null, draft: null, events: [] }));
}

const db = await import('../../src/server/db');
const { withActor, noteChatActor, actorFromAuth } = await import('../../src/server/actor');
const raw = () => new DatabaseSync(path.join(dir, 'aicb.db'));

test('Bestands-DB: Migrationen laufen bis zur aktuellen Version, Daten bleiben, alte JSON-Chats werden übernommen', () => {
  assert.equal(db.chatGet('alt')?.title, 'Bestandschat');
  assert.equal(db.chatGet('json1')?.title, 'Aus JSON', 'migrated_v1 läuft weiterhin');
  const r = raw();
  assert.equal(db.schemaVersion(r), db.MIGRATIONS.length);
  assert.ok((r.prepare('PRAGMA table_info(audit)').all() as { name: string }[]).some(c => c.name === 'actor'));
  const idx = (r.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map(i => i.name);
  for (const n of ['access_log_ts', 'access_log_chat', 'audit_ts', 'chats_updated']) assert.ok(idx.includes(n), n);
  assert.equal(db.auditList()[0].title, 'Bestand');
  assert.equal(db.auditList()[0].actor, undefined, 'alte Einträge ohne Akteur');
  // erneut ausführen: nichts passiert (kein doppeltes ALTER TABLE)
  db.runMigrations(r); assert.equal(db.schemaVersion(r), db.MIGRATIONS.length);
  // jeder Schritt ist auch auf einer DB idempotent, die das Schema schon hat (user_version zurückgesetzt)
  r.exec('PRAGMA user_version = 0'); db.runMigrations(r); assert.equal(db.schemaVersion(r), db.MIGRATIONS.length);
  r.close();
});

test('Neuere DB (Downgrade): unbekannte Version wird nicht angefasst', () => {
  const m = new DatabaseSync(':memory:');
  m.exec(`PRAGMA user_version = ${db.MIGRATIONS.length + 5}`);
  db.runMigrations(m);
  assert.equal(db.schemaVersion(m), db.MIGRATIONS.length + 5);
  assert.equal(m.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'kv'").get()?.n, 0);
});

test('Migration schlägt fehl → Transaktion zurückgerollt, Version bleibt', () => {
  const m = new DatabaseSync(':memory:');
  db.MIGRATIONS.push(d => { d.exec('CREATE TABLE halb (x)'); throw new Error('kaputt'); });
  try { assert.throws(() => db.runMigrations(m), /kaputt/); } finally { db.MIGRATIONS.pop(); }
  assert.equal(db.schemaVersion(m), db.MIGRATIONS.length, 'die gültigen Schritte sind durch');
  assert.equal(m.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'halb'").get()?.n, 0);
});

test('Datenbankdateien haben Rechte 600 (auch eine bestehende 644-Datei)', { skip: process.platform === 'win32' }, () => {
  db.kvSet('x', 1);
  for (const f of ['aicb.db', 'aicb.db-wal', 'aicb.db-shm']) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) assert.equal(fs.statSync(p).mode & 0o777, 0o600, f);
  }
});

test('Chatliste: erste Seite wie bisher, Blättern per (updated_at, id), Titelsuche mit LIKE-Sonderzeichen', () => {
  for (let i = 0; i < 5; i++) db.chatPut({ id: `p${i}`, title: i === 3 ? '100%_Rabatt' : `Seite ${i}`, target: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: `2026-01-0${i + 1}T00:00:00.000Z`, sdkSessionId: null, draft: null, events: [] });
  db.chatPut({ id: 'p9', title: 'Gleichzeitig', target: null, createdAt: '2026-01-05T00:00:00.000Z', updatedAt: '2026-01-05T00:00:00.000Z', sdkSessionId: null, draft: null, events: [] });
  const all = db.chatList();
  assert.deepEqual(all.map(c => c.id), ['p9', 'p4', 'p3', 'p2', 'p1', 'p0', 'alt', 'json1']);
  const seen: string[] = []; let before: { updatedAt: string; id: string } | null = null;
  for (;;) { const page = db.chatList({ limit: 3, before }); seen.push(...page.map(c => c.id)); if (page.length < 3) break; const l = page.at(-1)!; before = { updatedAt: l.updatedAt, id: l.id }; }
  assert.deepEqual(seen, all.map(c => c.id), 'keine Lücken, keine Doppelten – auch bei gleichem updated_at');
  assert.deepEqual(db.chatList({ q: '100%_' }).map(c => c.id), ['p3']);
  assert.deepEqual(db.chatList({ q: '%' }).map(c => c.id), ['p3'], '% wird wörtlich gesucht');
  assert.deepEqual(db.chatList({ q: 'seite', limit: 2 }).map(c => c.id), ['p4', 'p2']);
  assert.equal(db.chatList({ limit: 10_000 }).length, all.length, 'höchstens CHAT_PAGE');
});

test('Route /api/chats: ohne Parameter Array wie bisher, mit before/q weiterblättern', async () => {
  const { GET } = await import('../../src/app/api/chats/route');
  const get = async (qs = '') => (await GET(new Request(`http://localhost/api/chats${qs}`))).json() as Promise<{ id: string }[]>;
  assert.deepEqual((await get()).map(c => c.id), db.chatList().map(c => c.id));
  assert.deepEqual((await get('?before=2026-01-03T00:00:00.000Z&beforeId=p2')).map(c => c.id), ['p1', 'p0', 'alt', 'json1']);
  assert.deepEqual((await get('?q=Rabatt')).map(c => c.id), ['p3']);
  assert.deepEqual((await get('?limit=2')).map(c => c.id), ['p9', 'p4']);
});

test('Aufbewahrung: alte Zugriffs-/Audit-Zeilen werden gelöscht, Audit von Chats mit offenem Lauf bleibt', () => {
  const r = raw();
  r.prepare('INSERT INTO access_log (ts, op, entity) VALUES (?, ?, ?)').run(old(200), 'search', 'alt');
  r.prepare('INSERT INTO audit (ts, json) VALUES (?, ?)').run(old(400), JSON.stringify({ decision: 'approved', title: 'uralt' }));
  r.prepare('INSERT INTO audit (ts, json) VALUES (?, ?)').run(old(400), JSON.stringify({ chatId: 'p1', decision: 'approved', title: 'uralt-offen' }));
  r.prepare('INSERT INTO audit (ts, json) VALUES (?, ?)').run(old(400), 'kein json');
  db.runPut({ csId: 'cs1', chatId: 'p1', kind: 'products', title: 'x', startedAt: old(400), results: [], undo: [] });
  assert.deepEqual(db.pruneLogs(), { access: 1, audit: 2 });
  const titles = db.auditList(1000).map(a => a.title);
  assert.ok(titles.includes('uralt-offen') && titles.includes('Bestand') && !titles.includes('uralt'));
  assert.equal(db.accessList(1000).length, 1, 'der 10 Tage alte Eintrag bleibt');
  db.runDelete('cs1'); r.close();
});

test('Aufbewahrung: Umgebungsvariablen, 0 = nie, Audit mindestens 30 Tage', () => {
  try {
    assert.deepEqual(db.retention(), { access: 180, audit: 365 });
    process.env.LOTSE_LOG_RETENTION_DAYS = '0'; process.env.LOTSE_AUDIT_RETENTION_DAYS = '5';
    assert.deepEqual(db.retention(), { access: 0, audit: 30 });
    process.env.LOTSE_LOG_RETENTION_DAYS = 'quatsch'; process.env.LOTSE_AUDIT_RETENTION_DAYS = '-1';
    assert.deepEqual(db.retention(), { access: 180, audit: 365 });
    process.env.LOTSE_LOG_RETENTION_DAYS = '7.9'; process.env.LOTSE_AUDIT_RETENTION_DAYS = '0';
    assert.deepEqual(db.retention(), { access: 7, audit: 0 });
    raw().prepare('INSERT INTO audit (ts, json) VALUES (?, ?)').run(old(5000), JSON.stringify({ decision: 'approved', title: 'ewig' }));
    db.pruneLogs();
    assert.ok(db.auditList(1000).some(a => a.title === 'ewig'), 'Audit 0 = nie löschen');
  } finally { delete process.env.LOTSE_LOG_RETENTION_DAYS; delete process.env.LOTSE_AUDIT_RETENTION_DAYS; }
});

test('Akteur: Benutzername aus Basic Auth (UTF-8), nur mit LOTSE_PASSWORD', () => {
  const basic = (s: string) => 'Basic ' + Buffer.from(s, 'utf8').toString('base64');
  assert.equal(actorFromAuth(basic('jürgen:geheim')), null, 'ohne LOTSE_PASSWORD kein Akteur');
  process.env.LOTSE_PASSWORD = 'geheim';
  try {
    assert.equal(actorFromAuth(basic('jürgen:geheim:mit:doppelpunkt')), 'jürgen');
    assert.equal(actorFromAuth(basic(':geheim')), null);
    assert.equal(actorFromAuth(basic('ohnedoppelpunkt')), null);
    assert.equal(actorFromAuth('Bearer abc'), null);
    assert.equal(actorFromAuth(null), null);
    assert.equal(actorFromAuth(basic('a\nb:x')), 'ab', 'Steuerzeichen entfernt');
  } finally { delete process.env.LOTSE_PASSWORD; }
});

test('Akteur im Audit: Rückgängig im Anfrage-Kontext, Anwenden über den Chat der Freigabe', async () => {
  await withActor('anna', async () => { await Promise.resolve(); db.auditAdd({ chatId: 'p1', decision: 'undo' }); });
  assert.equal(db.auditList(1)[0].actor, 'anna');
  noteChatActor('p2', 'bernd');
  db.auditAdd({ chatId: 'p2', decision: 'approved', status: 'applied' });
  assert.equal(db.auditList(1)[0].actor, 'bernd');
  db.auditAdd({ chatId: 'p3', decision: 'approved' });
  assert.equal(db.auditList(1)[0].actor, undefined, 'anderer Chat: kein Akteur');
  db.auditAdd({ decision: 'changed', kind: 'settings' });
  assert.equal(db.auditList(1)[0].actor, undefined);
});

test('Route /api/approve merkt sich den Benutzernamen für das folgende Anwenden', async () => {
  process.env.LOTSE_PASSWORD = 'pw';
  try {
    const { POST } = await import('../../src/app/api/approve/route');
    const res = await POST(new Request('http://localhost/api/approve', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from('carla:pw').toString('base64') }, body: JSON.stringify({ chatId: 'p4', approvalId: 'gibtsnicht', allow: true }) }));
    assert.equal(res.status, 404);
    db.auditAdd({ chatId: 'p4', decision: 'approved', status: 'started' });
    assert.equal(db.auditList(1)[0].actor, 'carla');
  } finally { delete process.env.LOTSE_PASSWORD; }
});

test('docker/db-snapshot.mjs: stimmiger Schnappschuss einer laufenden WAL-DB (inkl. nicht zurückgeschriebener WAL-Inhalte)', () => {
  const live = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-snap-'));
  const d = new DatabaseSync(path.join(live, 'aicb.db'));
  d.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (x); INSERT INTO t VALUES (1), (2);');
  assert.ok(fs.statSync(path.join(live, 'aicb.db-wal')).size > 0, 'Daten liegen noch im WAL');
  const script = fs.readFileSync(path.join(import.meta.dirname, '../../docker/db-snapshot.mjs'), 'utf8');
  const r = spawnSync(process.execPath, ['--input-type=module', '-'], { input: script, env: { ...process.env, AICB_DATA: live }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const snap = path.join(live, '.backup', 'aicb.db');
  if (process.platform !== 'win32') assert.equal(fs.statSync(snap).mode & 0o777, 0o600);
  const s = new DatabaseSync(snap, { readOnly: true });
  assert.deepEqual(s.prepare('SELECT x FROM t ORDER BY x').all().map(r => (r as { x: number }).x), [1, 2]);
  assert.equal((s.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'delete', 'eigenständige Datei ohne -wal');
  s.close(); d.close();
});

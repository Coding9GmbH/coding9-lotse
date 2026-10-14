// Konsistenter Schnappschuss der SQLite-Datenbank für `make backup` (läuft im laufenden Container: node --input-type=module - < docker/db-snapshot.mjs).
// Die DB läuft im WAL-Modus: einfach die Dateien zu kopieren kann einen halben Stand erwischen. VACUUM INTO schreibt
// einen in sich stimmigen Stand (inkl. WAL) in eine neue Datei: <Datenordner>/.backup/aicb.db (Rechte 600).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const dir = process.env.AICB_DATA || '/data', out = path.join(dir, '.backup'), file = path.join(out, 'aicb.db');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { mode: 0o700 });
const src = path.join(dir, 'aicb.db');
if (fs.existsSync(src)) {
  const db = new DatabaseSync(src, { readOnly: true });
  try { db.prepare('VACUUM INTO ?').run(file); } finally { db.close(); }
  fs.chmodSync(file, 0o600);
  console.log('Lotse: Datenbank-Schnappschuss erstellt');
} else console.log('Lotse: noch keine Datenbank vorhanden');

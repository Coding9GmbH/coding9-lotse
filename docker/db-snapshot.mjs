// Consistent snapshot of the SQLite database for `make backup` (runs in the running container: node --input-type=module - < docker/db-snapshot.mjs).
// The DB runs in WAL mode: simply copying the files can catch a half-written state. VACUUM INTO writes
// a self-consistent state (incl. WAL) to a new file: <data dir>/.backup/aicb.db (mode 600).
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

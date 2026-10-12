import 'server-only';
// Wissensbasis (nur lokal, nie im Shop): Dokumente mit Textabschnitten, Produkt-/Kategorie-Bezug und eigene Regeln des Shops.
// Eigene SQLite-Datei im Datenordner; Suche lokal per BM25 (knowledge-search.ts).
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RULE_MAX, RULE_SCOPES, TITLE_MAX, type KnowledgeDoc, type KnowledgeLink, type KnowledgeRule, type KnowledgeSource, type RuleScope } from '@/lib/knowledge';
import { dataDir } from './db';
import { deleteFile, getFile } from './files';
import { buildIndex, containsLoose, fold, search, type SearchIndex } from './knowledge-search';
import { chunkSegments, citation, extractSegments, MAX_TEXT, type Segment } from './knowledge-text';
import { singleton } from './state';

function open(): DatabaseSync {
  fs.mkdirSync(dataDir(), { recursive: true });
  const d = new DatabaseSync(path.join(dataDir(), 'knowledge.db'));
  d.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS docs (id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT NOT NULL, file_id TEXT, file_name TEXT, mime TEXT, size INTEGER, pages INTEGER,
      chars INTEGER, chunks INTEGER, tags TEXT NOT NULL, links TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chunks (doc_id TEXT NOT NULL, idx INTEGER NOT NULL, page INTEGER, label TEXT, text TEXT NOT NULL, text_fold TEXT, PRIMARY KEY (doc_id, idx));
    CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, text TEXT NOT NULL, scope TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
  // Ältere Datenbanken: gefaltete Textspalte (wörtliche Suche per LIKE statt alle Abschnitte in den Speicher zu laden) nachrüsten
  const cols = d.prepare("SELECT name FROM pragma_table_info('chunks')").all() as unknown as { name: string }[];
  if (!cols.some(c => c.name === 'text_fold')) {
    d.exec('ALTER TABLE chunks ADD COLUMN text_fold TEXT');
    const upd = d.prepare('UPDATE chunks SET text_fold = ? WHERE doc_id = ? AND idx = ?');
    for (const r of d.prepare('SELECT doc_id, idx, text FROM chunks').all() as unknown as { doc_id: string; idx: number; text: string }[]) upd.run(foldText(r.text), r.doc_id, r.idx);
  }
  return d;
}
/** Gefaltete Form für die wörtliche Suche (wie containsLoose: Kleinschreibung, Umlaute, ein Leerzeichen) */
const foldText = (s: string) => fold(s).replace(/\s+/g, ' ');
/** LIKE-Muster für einen Suchbegriff (Jokerzeichen maskiert) */
const likeNeedle = (s: string) => `%${foldText(s).trim().replace(/[\\%_]/g, '\\$&')}%`;
// Je Datenordner eine Verbindung (Tests wechseln AICB_DATA)
const db = () => singleton(`knowledge-db:${dataDir()}`, open);
const state = () => singleton(`knowledge-state:${dataDir()}`, () => ({ version: 0, built: -1, index: null as SearchIndex | null }));
const touch = () => { state().version++; };
const tx = <T>(fn: () => T): T => { const d = db(); d.exec('BEGIN'); try { const r = fn(); d.exec('COMMIT'); return r; } catch (e) { d.exec('ROLLBACK'); throw e; } };
const now = () => new Date().toISOString();
const newId = (p: string) => `${p}_${crypto.randomBytes(8).toString('hex')}`;

// ---------- Dokumente ----------
interface DocRow { id: string; title: string; source: string; file_id: string | null; file_name: string | null; mime: string | null; size: number; pages: number | null; chars: number; chunks: number; tags: string; links: string; created_at: string; updated_at: string }
const toDoc = (r: DocRow): KnowledgeDoc => ({
  id: r.id, title: r.title, source: r.source as KnowledgeSource, fileId: r.file_id, fileName: r.file_name, mime: r.mime, size: r.size, pages: r.pages,
  chars: r.chars, chunks: r.chunks, tags: JSON.parse(r.tags), links: JSON.parse(r.links), createdAt: r.created_at, updatedAt: r.updated_at,
});
export const listDocs = (): KnowledgeDoc[] => (db().prepare('SELECT * FROM docs ORDER BY updated_at DESC').all() as unknown as DocRow[]).map(toDoc);
export const getDoc = (id: string): KnowledgeDoc | null => { const r = db().prepare('SELECT * FROM docs WHERE id = ?').get(id) as DocRow | undefined; return r ? toDoc(r) : null; };
export const docByFileId = (fileId: string): KnowledgeDoc | null => { const r = db().prepare('SELECT * FROM docs WHERE file_id = ? LIMIT 1').get(fileId) as DocRow | undefined; return r ? toDoc(r) : null; };

const cleanTags = (tags: string[] = []) => [...new Set(tags.map(t => t.trim().slice(0, 40)).filter(Boolean))].slice(0, 20);
const cleanLinks = (links: KnowledgeLink[] = []) => {
  const seen = new Set<string>();
  return links.filter(l => l.id && (l.kind === 'product' || l.kind === 'category') && !seen.has(l.kind + l.id) && seen.add(l.kind + l.id))
    .slice(0, 200).map(l => ({ kind: l.kind, id: l.id, number: l.number ?? null, name: l.name ? String(l.name).slice(0, 200) : null }));
};
const cleanTitle = (t: string) => t.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);

export interface DocInput { title: string; tags?: string[]; links?: KnowledgeLink[] }
interface Extracted { segments: Segment[]; pages?: number; source: KnowledgeSource; fileId?: string; fileName?: string; mime?: string; size: number }

/** Vorschau ohne Speichern (für die Rückfrage vor dem Aufnehmen). */
export async function extractFromFile(fileId: string): Promise<Extracted> {
  const f = getFile(fileId); if (!f) throw new Error(`Datei ${fileId} nicht gefunden`);
  const { segments, pages } = await extractSegments(f.buf, f.name);
  return { segments, pages, source: 'chat', fileId, fileName: f.name, mime: f.mime, size: f.size };
}
export const extractFromText = (text: string): Extracted => ({ segments: [{ text: text.trim() }], source: 'text', size: Buffer.byteLength(text) });
export const extractedChars = (x: Extracted) => x.segments.reduce((n, s) => n + s.text.length, 0);

export function addDocument(x: Extracted, input: DocInput): KnowledgeDoc {
  const chars = extractedChars(x);
  if (!chars) throw new Error('Kein Text gefunden: die Datei ist leer oder enthält nur Bilder.');
  if (chars > MAX_TEXT) throw new Error(`Zu viel Text (${chars.toLocaleString('de-DE')} Zeichen, max. ${MAX_TEXT.toLocaleString('de-DE')}). Bitte aufteilen.`);
  const chunks = chunkSegments(x.segments), t = now();
  const doc: KnowledgeDoc = {
    id: newId('k'), title: cleanTitle(input.title) || x.fileName || 'Notiz', source: x.source, fileId: x.fileId ?? null, fileName: x.fileName ?? null, mime: x.mime ?? null,
    size: x.size, pages: x.pages ?? null, chars, chunks: chunks.length, tags: cleanTags(input.tags), links: cleanLinks(input.links), createdAt: t, updatedAt: t,
  };
  tx(() => {
    const d = db();
    d.prepare('INSERT INTO docs (id, title, source, file_id, file_name, mime, size, pages, chars, chunks, tags, links, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(doc.id, doc.title, doc.source, doc.fileId ?? null, doc.fileName ?? null, doc.mime ?? null, doc.size, doc.pages ?? null, doc.chars, doc.chunks, JSON.stringify(doc.tags), JSON.stringify(doc.links), t, t);
    const ins = d.prepare('INSERT INTO chunks (doc_id, idx, page, label, text, text_fold) VALUES (?, ?, ?, ?, ?, ?)');
    for (const c of chunks) ins.run(doc.id, c.idx, c.page ?? null, c.label ?? null, c.text, foldText(c.text));
  });
  touch();
  return doc;
}

export function updateDoc(id: string, patch: Partial<DocInput>): KnowledgeDoc {
  const doc = getDoc(id); if (!doc) throw new Error('Dokument nicht gefunden');
  const next = { title: patch.title != null ? cleanTitle(patch.title) || doc.title : doc.title, tags: patch.tags ? cleanTags(patch.tags) : doc.tags, links: patch.links ? cleanLinks(patch.links) : doc.links };
  db().prepare('UPDATE docs SET title = ?, tags = ?, links = ?, updated_at = ? WHERE id = ?').run(next.title, JSON.stringify(next.tags), JSON.stringify(next.links), now(), id);
  touch();
  return getDoc(id)!;
}

/** Löscht Dokument + Abschnitte; auf der Seite Wissen hochgeladene Dateien werden mitgelöscht (Chat-Anhänge bleiben). */
export function deleteDoc(id: string): boolean {
  const doc = getDoc(id); if (!doc) return false;
  tx(() => { db().prepare('DELETE FROM chunks WHERE doc_id = ?').run(id); db().prepare('DELETE FROM docs WHERE id = ?').run(id); });
  if (doc.source === 'upload' && doc.fileId && !docByFileId(doc.fileId)) deleteFile(doc.fileId);
  touch();
  return true;
}

// ---------- Suche ----------
interface ChunkRow { doc_id: string; idx: number; page: number | null; label: string | null; text: string; text_fold?: string | null }
export interface KnowledgeHit { docId: string; title: string; cite: string; page?: number; label?: string; text: string; score?: number; match?: string }

function index(): SearchIndex {
  const s = state();
  if (s.index && s.built === s.version) return s.index;
  const rows = db().prepare('SELECT c.doc_id, c.idx, c.text, d.title FROM chunks c JOIN docs d ON d.id = c.doc_id').all() as unknown as (ChunkRow & { title: string })[];
  s.index = buildIndex(rows.map(r => ({ key: `${r.doc_id}:${r.idx}`, text: `${r.title}\n${r.text}` }))); s.built = s.version;
  return s.index;
}

const hitOf = (r: ChunkRow, docs: Map<string, KnowledgeDoc>, score?: number): KnowledgeHit => {
  const d = docs.get(r.doc_id)!;
  return { docId: r.doc_id, title: d.title, cite: citation(d.title, r), ...(r.page ? { page: r.page } : {}), ...(r.label ? { label: r.label } : {}), text: r.text, ...(score != null ? { score } : {}) };
};
const chunkRow = (key: string) => { const i = key.lastIndexOf(':'); return db().prepare('SELECT * FROM chunks WHERE doc_id = ? AND idx = ?').get(key.slice(0, i), Number(key.slice(i + 1))) as ChunkRow | undefined; };
const linked = (d: KnowledgeDoc, productId?: string, categoryIds: string[] = []) => d.links.some(l => (l.kind === 'product' && l.id === productId) || (l.kind === 'category' && categoryIds.includes(l.id)));

/** BM25-Suche; Abschnitte aus Dokumenten, die mit dem Produkt (oder seinen Kategorien) verknüpft sind, zählen 1,5-fach. */
export function searchKnowledge(query: string, opts: { productId?: string; categoryIds?: string[]; limit?: number } = {}): KnowledgeHit[] {
  const docs = new Map(listDocs().map(d => [d.id, d]));
  const boost = (key: string) => { const d = docs.get(key.slice(0, key.lastIndexOf(':'))); return d && (opts.productId || opts.categoryIds?.length) && linked(d, opts.productId, opts.categoryIds) ? 1.5 : 1; };
  return search(index(), query, Math.min(Math.max(opts.limit ?? 6, 1), 20), boost)
    .map(h => { const r = chunkRow(h.key); return r && docs.has(r.doc_id) ? hitOf(r, docs, h.score) : null; }).filter((h): h is KnowledgeHit => !!h);
}

/** Alles Wissen zu einem Produkt: verknüpfte Dokumente (bzw. über die Kategorien) + Abschnitte, die Artikelnummer, EAN oder Namen wörtlich nennen.
 *  Die wörtliche Suche läuft in SQLite (gefaltete Spalte, LIKE, LIMIT): auch große Wissensbasen werden nicht in den Speicher geladen. */
export function productKnowledge(p: { id: string; number?: string | null; ean?: string | null; name?: string | null; categoryIds?: string[] }, limit = 30) {
  const docs = new Map(listDocs().map(d => [d.id, d]));
  const linkedDocs = [...docs.values()].filter(d => linked(d, p.id, p.categoryIds));
  const out: KnowledgeHit[] = []; const seen = new Set<string>();
  const add = (r: ChunkRow, why: string) => { const k = `${r.doc_id}:${r.idx}`; if (seen.has(k) || out.length >= limit) return; seen.add(k); out.push({ ...hitOf(r, docs), match: why }); };
  for (const d of linkedDocs) for (const r of db().prepare('SELECT * FROM chunks WHERE doc_id = ? ORDER BY idx').all(d.id) as unknown as ChunkRow[]) add(r, d.links.some(l => l.kind === 'product' && l.id === p.id) ? 'verknüpft' : 'Kategorie verknüpft');
  const needles = [p.number, p.ean, p.name].filter((x): x is string => !!x && x.trim().length >= 3);
  for (const n of needles) {
    if (out.length >= limit) break;
    if (foldText(n).trim().length < 3) continue; // wie containsLoose: zu kurze Begriffe (z. B. nur Akzente) treffen nicht alles
    const why = n === p.number ? 'Artikelnummer genannt' : n === p.ean ? 'EAN genannt' : 'Name genannt';
    // Dokumente, deren Titel den Begriff nennt (Titel sind wenige: einmal je Dokument falten)
    const byTitle = [...docs.values()].filter(d => containsLoose(d.title, n)).map(d => d.id);
    for (const id of byTitle) for (const r of db().prepare('SELECT * FROM chunks WHERE doc_id = ? ORDER BY idx LIMIT ?').all(id, limit) as unknown as ChunkRow[]) add(r, why);
    if (out.length >= limit) break;
    for (const r of db().prepare("SELECT * FROM chunks WHERE text_fold LIKE ? ESCAPE '\\' ORDER BY doc_id, idx LIMIT ?").all(likeNeedle(n), limit) as unknown as ChunkRow[]) if (docs.has(r.doc_id)) add(r, why);
  }
  return { linkedDocs: linkedDocs.map(d => ({ id: d.id, title: d.title })), chunks: out };
}

// ---------- Eigene Regeln ----------
interface RuleRow { id: string; text: string; scope: string; created_at: string; updated_at: string }
const toRule = (r: RuleRow): KnowledgeRule => ({ id: r.id, text: r.text, scope: r.scope as RuleScope, createdAt: r.created_at, updatedAt: r.updated_at });
const cleanRule = (text: string) => {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) throw new Error('Regel ist leer');
  if (t.length > RULE_MAX) throw new Error(`Regel zu lang (max. ${RULE_MAX} Zeichen)`);
  return t;
};
const checkScope = (s: string): RuleScope => { if (!(s in RULE_SCOPES)) throw new Error(`Unbekannter Bereich „${s}“`); return s as RuleScope; };

export const listRules = (): KnowledgeRule[] => (db().prepare('SELECT * FROM rules ORDER BY created_at').all() as unknown as RuleRow[]).map(toRule);
export function addRule(text: string, scope: string = 'all'): KnowledgeRule {
  const t = now(), r: KnowledgeRule = { id: newId('r'), text: cleanRule(text), scope: checkScope(scope), createdAt: t, updatedAt: t };
  if (listRules().length >= 100) throw new Error('Höchstens 100 Regeln');
  db().prepare('INSERT INTO rules (id, text, scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(r.id, r.text, r.scope, t, t);
  return r;
}
export function updateRule(id: string, patch: { text?: string; scope?: string }): KnowledgeRule {
  const cur = listRules().find(r => r.id === id); if (!cur) throw new Error('Regel nicht gefunden');
  const text = patch.text != null ? cleanRule(patch.text) : cur.text, scope = patch.scope != null ? checkScope(patch.scope) : cur.scope;
  db().prepare('UPDATE rules SET text = ?, scope = ?, updated_at = ? WHERE id = ?').run(text, scope, now(), id);
  return listRules().find(r => r.id === id)!;
}
export const removeRule = (id: string): boolean => Number(db().prepare('DELETE FROM rules WHERE id = ?').run(id).changes) > 0;

export const PROMPT_RULES = { count: 40, chars: 3000 };
/** Regeln für den System-Prompt: kompakt, gedeckelt (Anzahl + Zeichen), Rest nur über list_rules. */
export function rulesPromptBlock(rules: KnowledgeRule[] = listRules(), cap = PROMPT_RULES): string {
  if (!rules.length) return '';
  const lines: string[] = []; let size = 0;
  for (const r of rules) {
    const line = `- ${r.scope === 'all' ? '' : `[${RULE_SCOPES[r.scope]}] `}${r.text.replace(/\s+/g, ' ')}`;
    if (lines.length >= cap.count || size + line.length > cap.chars) break;
    lines.push(line); size += line.length + 1;
  }
  const rest = rules.length - lines.length;
  return `## Eigene Regeln des Shops (VERBINDLICH für alle Texte)\nVom Shop festgelegt; gelten zusätzlich zum Styleguide und gehen bei Widerspruch vor. In Klammern: nur für diesen Bereich.\n${lines.join('\n')}${rest > 0 ? `\n(+${rest} weitere Regeln: mit list_rules lesen, bevor du Texte schreibst)` : ''}`;
}

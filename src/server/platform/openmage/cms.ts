import 'server-only';
// OpenMage: CMS-Seiten und CMS-Blöcke lesen (Werkzeuge) und vorhandene CMS-Seiten ändern (Titel, Inhalt, Metas, aktiv) als
// Änderungsset mit exaktem Rückgängig. PATCH schreibt nur die gesendeten Felder und behält die Store-Zuordnung; Rückgängig
// schreibt dieselben Felder mit den Vorher-Werten zurück. Blöcke werden nur gelesen.
import type { ChangeItem, ChangeSet, UndoOp } from '@/lib/protocol';
import { errMsg, newIdSafe, partialTicker, pool, WRITE_CONCURRENCY, type ApplyResult } from './kit';
import { plain, same, type OmRecord } from './map';
import { noDirectives } from '../magento/pagebuilder';
import type { OmReader } from './reader';
import { reg, reqOp } from './write';

const DIRECTIVE = /\{\{[\s\S]*?\}\}/g;
/** Neue Direktiven ({{block}}, {{widget}}, {{config}} …) entschärfen; solche, die schon im Inhalt standen, bleiben erhalten */
export function directiveGuard(cur: unknown): (html: string) => string {
  const known = new Set(String(cur ?? '').match(DIRECTIVE) ?? []);
  return html => html.replace(DIRECTIVE, d => (known.has(d) ? d : noDirectives(d)));
}
const cut = (t: unknown, n = 200) => { const s = plain(t); return s.length > n ? `${s.slice(0, n)}…` : s || '–'; };
/** Seiten, die OpenMage selbst braucht (404, Cookie-Hinweis, Startseite): nicht ändern */
export const SYSTEM_PAGES = new Set(['no-route', 'enable-cookies', 'privacy-policy-cookie-restriction-mode', 'home']);
const storesText = (x: OmRecord) => ((x.stores ?? []) as { id: number; code?: string | null; name?: string | null }[]).map(s => (s.id === 0 ? 'alle Store-Views' : s.code ?? s.name ?? String(s.id))).join(', ');

export async function listCms(ro: OmReader, a: { entity: 'page' | 'block'; term?: string; limit?: number; offset?: number }) {
  const n = Math.max(1, Math.min(a.limit ?? 30, 100)), page = Math.floor(Math.max(0, a.offset ?? 0) / n) + 1;
  // Suchbegriff in Titel ODER identifier: eine Abfrage (?term=, Modul ab 1.2.0) mit exakter Paginierung; ältere Module: zwei Abfragen zusammengeführt (Schätzwerte)
  const single = !a.term || await ro.hasTermFilter(), q = { page, limit: n, ...(a.term ? (single ? { term: a.term } : { title: a.term }) : {}) };
  const r = a.entity === 'page' ? await ro.cmsPages(q) : await ro.cmsBlocks(q);
  if (a.term && !single) { const r2 = a.entity === 'page' ? await ro.cmsPages({ ...q, title: undefined, identifier: a.term }) : await ro.cmsBlocks({ ...q, title: undefined, identifier: a.term }); for (const x of r2.items) if (!r.items.some(y => y.id === x.id)) r.items.push(x); r.meta.total = Math.max(r.meta.total, r.items.length); }
  return {
    total: r.meta.total, offset: (page - 1) * n, ...(page * n < r.meta.total ? { nextOffset: page * n } : {}),
    items: r.items.map(x => ({ id: String(x.id), identifier: x.identifier, title: x.title, active: !!x.is_active, stores: storesText(x), ...(a.entity === 'page' ? { url: x.url ?? null, metaDescription: x.meta_description ?? null, contentHeading: x.content_heading ?? null, layout: x.root_template ?? null } : {}), updated: x.update_time ?? null })),
    hint: a.entity === 'page' ? 'Inhalt und Wortzahl mit get_cms_page' : undefined,
  };
}

async function findPage(ro: OmReader, id: string): Promise<OmRecord | null> {
  if (/^\d+$/.test(id)) return ro.cmsPage(id);
  const hit = await ro.cmsPageByIdentifier(id);
  return hit ? ro.cmsPage(hit.id) : null;
}
export async function getCms(ro: OmReader, entity: 'page' | 'block', id: string) {
  const x = entity === 'page' ? await findPage(ro, id) : /^\d+$/.test(id) ? await ro.cmsBlock(id) : await (async () => { const b = (await ro.cmsBlocks({ identifier: id, limit: 20 })).items.find(y => y.identifier === id); return b ? ro.cmsBlock(b.id) : null; })();
  if (!x) return null;
  const html = String(x.content ?? '');
  return { id: String(x.id), identifier: x.identifier, title: x.title, active: !!x.is_active, stores: storesText(x), ...(entity === 'page' ? { url: x.url ?? null, metaDescription: x.meta_description ?? null, metaKeywords: x.meta_keywords ?? null, contentHeading: x.content_heading ?? null, layout: x.root_template ?? null, hasLayoutXml: !!x.layout_update_xml } : {}), html, words: plain(html).split(/\s+/).filter(Boolean).length, text: cut(html, 4000), directives: (html.match(DIRECTIVE) ?? []).slice(0, 20) };
}

// ================= Seiten ändern =================
const FIELDS: Record<string, { key: string; label: string }> = { title: { key: 'title', label: 'Seitentitel' }, contentHeading: { key: 'content_heading', label: 'Überschrift (H1)' }, content: { key: 'content', label: 'Inhalt' }, metaDescription: { key: 'meta_description', label: 'Meta-Description' }, metaKeywords: { key: 'meta_keywords', label: 'Meta-Keywords' }, active: { key: 'is_active', label: 'Aktiv' } };
export const CMS_FIELDS = Object.keys(FIELDS);
export interface CmsChangeArgs { title: string; reason: string; changes: { id: string; fields: Record<string, unknown> }[] }
interface CmsPlan { id: string; write: OmRecord; expect: OmRecord }

export async function buildCmsPageChangeSet(ro: OmReader, a: CmsChangeArgs): Promise<{ cs: ChangeSet; payload: { plans: Record<string, CmsPlan> } }> {
  if (!a.changes?.length) throw new Error('changes ist leer');
  if (a.changes.length > 50) throw new Error('Maximal 50 Seiten je Änderungsset');
  const items: ChangeItem[] = [], skipped: { id: string; reason: string }[] = [], plans: Record<string, CmsPlan> = {};
  for (const ch of a.changes) {
    const pg = await findPage(ro, String(ch.id));
    if (!pg) { skipped.push({ id: ch.id, reason: `Seite ${ch.id} nicht gefunden` }); continue; }
    if (SYSTEM_PAGES.has(String(pg.identifier))) { skipped.push({ id: ch.id, reason: `„${pg.title}“ ist eine Systemseite von OpenMage` }); continue; }
    const id = String(pg.id), write: OmRecord = {}, expect: OmRecord = {}, label = `CMS-Seite „${pg.title}“ (/${pg.identifier})`;
    for (const [f, v] of Object.entries(ch.fields ?? {})) {
      const def = FIELDS[f];
      if (!def) { skipped.push({ id: `${id}:${f}`, reason: `Feld ${f} gibt es nicht (erlaubt: ${CMS_FIELDS.join(', ')})` }); continue; }
      if (f === 'active' ? typeof v !== 'boolean' : typeof v !== 'string') { skipped.push({ id: `${id}:${f}`, reason: `${def.label}: ${f === 'active' ? 'true/false' : 'Text'} erwartet` }); continue; }
      if (f === 'title' && !String(v).trim()) { skipped.push({ id: `${id}:${f}`, reason: 'Seitentitel darf nicht leer sein' }); continue; }
      const val = f === 'content' ? directiveGuard(pg.content)(String(v)) : v;
      const cur = pg[def.key];
      if (f === 'active' ? !!cur === v : same(cur, val)) continue;
      write[def.key] = val; expect[def.key] = cur ?? null;
      const warn = f === 'active' && v === false ? ['Seite ist danach nicht mehr erreichbar (404); Links darauf prüfen'] : f === 'content' ? ['Ersetzt den gesamten Inhalt der Seite'] : [];
      items.push({ id: `${id}:${f}`, entity: 'landing-page', entityId: id, label, field: f, fieldLabel: def.label, before: f === 'active' ? (cur ? 'ja' : 'nein') : cut(cur), after: f === 'active' ? (v ? 'ja' : 'nein') : cut(val), afterRaw: val, warn, ...(f === 'content' ? { html: { before: String(cur ?? ''), after: String(val) } } : {}) });
    }
    if (Object.keys(write).length) plans[id] = { id, write, expect };
  }
  if (!items.length) throw new Error(`Keine Änderung nötig bzw. nichts anwendbar${skipped.length ? `: ${skipped.map(s => s.reason).join('; ')}` : ''}`);
  return { cs: { id: newIdSafe(), kind: 'cms-pages', entity: 'landing-page', noun: { one: 'Seite', many: 'Seiten' }, title: a.title, reason: a.reason, items, skipped, atomic: false }, payload: { plans } };
}

// Je Seite EIN PATCH mit allen gewählten Feldern
reg.register('cms-pages', async (c, cs, payload, selected, ctx) => {
  const plans = (payload as { plans: Record<string, CmsPlan> }).plans, results: ApplyResult['results'] = [], undo: UndoOp[] = [];
  const byPage = new Map<string, ChangeItem[]>();
  let n = 0;
  for (const it of cs.items) if (selected.has(it.id) && it.entity !== 'info') { byPage.set(String(it.entityId), [...(byPage.get(String(it.entityId)) ?? []), it]); n++; }
  const tick = partialTicker(ctx, n, { results, undo });
  await pool([...byPage], WRITE_CONCURRENCY, async ([id, its]) => {
    try {
      const pl = plans[id]; if (!pl) throw new Error('Plan fehlt');
      const keys = its.map(it => FIELDS[String(it.field)].key), eq = (k: string, a: unknown, b: unknown) => (k === 'is_active' ? !!a === !!b : same(a, b));
      const cur = await c.req('GET', `/v1/cms/pages/${id}`) as OmRecord;
      const moved = its.filter((it, i) => !eq(keys[i], cur[keys[i]], pl.expect[keys[i]]));
      if (moved.length) throw new Error(`${moved.map(m => m.fieldLabel).join(', ')} wurde inzwischen geändert, bitte neu vorschlagen`);
      const data = Object.fromEntries(its.map((it, i) => [keys[i], it.afterRaw]));
      await c.req('PATCH', `/v1/cms/pages/${id}`, data);
      undo.push(reqOp('cms-page', id, 'PATCH', `/v1/cms/pages/${id}`, Object.fromEntries(keys.map(k => [k, k === 'is_active' ? !!cur[k] : cur[k] ?? null]))));
      const back = await c.req('GET', `/v1/cms/pages/${id}`) as OmRecord;
      const lost = its.filter((it, i) => !eq(keys[i], back[keys[i]], it.afterRaw));
      if (lost.length) throw new Error(`OpenMage hat ${lost.map(l => l.fieldLabel).join(', ')} nicht übernommen${lost.some(l => l.field === 'active') ? ' (Seite ist in der Konfiguration referenziert, z. B. als Startseite)' : ''}`);
      for (const it of its) results.push({ itemId: it.id, ok: true });
    } catch (e) { for (const it of its) results.push({ itemId: it.id, ok: false, error: errMsg(e) }); }
    finally { tick(); }
  });
  return { results, undo };
});

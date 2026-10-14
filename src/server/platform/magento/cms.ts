import 'server-only';
// Magento: read CMS pages and CMS blocks (tools) and change existing CMS pages (title, content, metas, active) as a
// change set with exact undo. Blocks are read-only: when saving a block via REST, Magento resets the
// store view assignment, which would not be exactly reversible.
import type { ChangeItem, ChangeSet, UndoOp } from '@/lib/protocol';
import { errMsg, newIdSafe, partialTicker, pool, WRITE_CONCURRENCY, type ApplyResult } from './kit';
import { plain, sameValue, type MRecord } from './map';
import { isPageBuilder, noDirectives, readableHtml, storableHtml, toPageBuilder } from './pagebuilder';
import type { MagentoReader } from './reader';
import { reg, reqOp } from './write';

const DIRECTIVE = /\{\{[\s\S]*?\}\}/g;
/** Defuse new directives ({{widget}}, {{config}} …) as when publishing; those already in the content are kept */
export function directiveGuard(cur: unknown): (html: string) => string {
  const known = new Set([...(String(cur ?? '').match(DIRECTIVE) ?? []), ...(readableHtml(String(cur ?? '')).match(DIRECTIVE) ?? [])]);
  return html => html.replace(DIRECTIVE, d => (known.has(d) ? d : noDirectives(d)));
}
/** New page content in the page's storage format: Page Builder pages stay Page Builder (html elements encoded, free HTML as html content type) */
export function cmsContent(cur: unknown, next: string): string {
  const guard = directiveGuard(cur);
  if (!isPageBuilder(String(cur ?? ''))) return guard(next);
  return isPageBuilder(next) ? storableHtml(guard(next)) : toPageBuilder([{ kind: 'html', html: guard(next), checked: true }]);
}

const cut = (t: unknown, n = 200) => { const s = plain(t); return s.length > n ? `${s.slice(0, n)}…` : s || '–'; };
const HTML_MAX = 60_000;
/** Limit HTML for the AI and the card: replace embedded data URIs (e.g. SVG from Lotse pages) with placeholders, truncate long content */
export function limitHtml(html: string, max = HTML_MAX): { html: string; truncated: boolean } {
  const s = html.replace(/data:([a-z0-9.+-]+\/[a-z0-9.+-]+)[^"')\s]{64,}/gi, (m, t: string) => `data:${t};… [eingebettet, ${Math.max(1, Math.round(m.length / 1024))} KB]`);
  return s.length > max ? { html: `${s.slice(0, max)}…`, truncated: true } : { html: s, truncated: false };
}
/** Pages Magento itself needs (404, cookie notice): don't change */
const SYSTEM_PAGES = new Set(['no-route', 'enable-cookies', 'privacy-policy-cookie-restriction-mode']);

export async function listCms(ro: MagentoReader, a: { entity: 'page' | 'block'; term?: string; limit?: number; offset?: number }) {
  const n = Math.max(1, Math.min(a.limit ?? 30, 100)), page = Math.floor(Math.max(0, a.offset ?? 0) / n) + 1;
  const filters = a.term ? [[{ field: 'title', value: `%${a.term.replace(/[\\%_]/g, m => `\\${m}`)}%`, condition_type: 'like' as const }, { field: 'identifier', value: `%${a.term.replace(/[\\%_]/g, m => `\\${m}`)}%`, condition_type: 'like' as const }]] : [];
  const r = a.entity === 'page' ? await ro.cmsPages({ filters, pageSize: n, currentPage: page }, 'all') : await ro.cmsBlocks({ filters, pageSize: n, currentPage: page }, 'all');
  const base = await ro.storefrontBase().catch(() => ro.publicUrl);
  return {
    total: r.total_count, offset: (page - 1) * n, ...(page * n < r.total_count ? { nextOffset: page * n } : {}),
    items: r.items.map(x => ({ id: String(x.id), identifier: x.identifier, title: x.title, active: !!x.active, ...(a.entity === 'page' ? { url: x.identifier === 'home' ? `${base}/` : `${base}/${x.identifier}`, metaTitle: x.meta_title ?? null, metaDescription: x.meta_description ?? null } : {}), pageBuilder: isPageBuilder(x.content), words: plain(readableHtml(x.content)).split(/\s+/).filter(Boolean).length, excerpt: cut(readableHtml(x.content), 160), updated: x.update_time ?? null })),
  };
}

export async function getCms(ro: MagentoReader, entity: 'page' | 'block', id: string) {
  const r = entity === 'page' ? await ro.cmsPages({ filters: [[{ field: /^\d+$/.test(id) ? 'page_id' : 'identifier', value: id }]], pageSize: 1 }, 'all') : await ro.cmsBlocks({ filters: [[{ field: /^\d+$/.test(id) ? 'block_id' : 'identifier', value: id }]], pageSize: 1 }, 'all');
  const x = r.items[0];
  if (!x) return null;
  const base = await ro.storefrontBase().catch(() => ro.publicUrl), h = limitHtml(readableHtml(x.content));
  return { id: String(x.id), identifier: x.identifier, title: x.title, active: !!x.active, ...(entity === 'page' ? { url: `${base}/${x.identifier === 'home' ? '' : x.identifier}`, metaTitle: x.meta_title ?? null, metaDescription: x.meta_description ?? null, contentHeading: x.content_heading ?? null, layout: x.page_layout ?? null } : {}), pageBuilder: isPageBuilder(x.content), html: h.html, ...(h.truncated ? { truncated: true, hint: `HTML auf ${HTML_MAX.toLocaleString('de-DE')} Zeichen gekürzt; Abschnitte gezielt mit read_page prüfen, beim Ändern nur Felder außer content vorschlagen` } : {}), text: cut(readableHtml(x.content), 4000) };
}

// ================= Change pages =================
const FIELDS: Record<string, { key: string; label: string }> = { title: { key: 'title', label: 'Seitentitel' }, content: { key: 'content', label: 'Inhalt' }, metaTitle: { key: 'meta_title', label: 'Meta-Title' }, metaDescription: { key: 'meta_description', label: 'Meta-Description' }, active: { key: 'active', label: 'Aktiv' } };
export const CMS_FIELDS = Object.keys(FIELDS);
export interface CmsChangeArgs { title: string; reason: string; changes: { id: string; fields: Record<string, unknown> }[] }
interface CmsPlan { id: string; write: MRecord; expect: MRecord }

export async function buildCmsPageChangeSet(ro: MagentoReader, a: CmsChangeArgs): Promise<{ cs: ChangeSet; payload: { plans: Record<string, CmsPlan> } }> {
  if (!a.changes?.length) throw new Error('changes ist leer');
  if (a.changes.length > 50) throw new Error('Maximal 50 Seiten je Änderungsset');
  const items: ChangeItem[] = [], skipped: { id: string; reason: string }[] = [], plans: Record<string, CmsPlan> = {};
  for (const ch of a.changes) {
    const r = await ro.cmsPages({ filters: [[{ field: /^\d+$/.test(ch.id) ? 'page_id' : 'identifier', value: ch.id }]], pageSize: 1 }, 'all');
    const pg = r.items[0];
    if (!pg) { skipped.push({ id: ch.id, reason: `Seite ${ch.id} nicht gefunden` }); continue; }
    if (SYSTEM_PAGES.has(String(pg.identifier))) { skipped.push({ id: ch.id, reason: `„${pg.title}“ ist eine Systemseite von Magento` }); continue; }
    const id = String(pg.id), write: MRecord = {}, expect: MRecord = {}, label = `CMS-Seite „${pg.title}“ (/${pg.identifier})`;
    for (const [f, v] of Object.entries(ch.fields ?? {})) {
      const def = FIELDS[f];
      if (!def) { skipped.push({ id: `${id}:${f}`, reason: `Feld ${f} gibt es nicht (erlaubt: ${CMS_FIELDS.join(', ')})` }); continue; }
      if (f === 'active' ? typeof v !== 'boolean' : typeof v !== 'string') { skipped.push({ id: `${id}:${f}`, reason: `${def.label}: ${f === 'active' ? 'true/false' : 'Text'} erwartet` }); continue; }
      if (f === 'title' && !String(v).trim()) { skipped.push({ id: `${id}:${f}`, reason: 'Seitentitel darf nicht leer sein' }); continue; }
      const val = f === 'content' ? cmsContent(pg.content, String(v)) : v;
      const cur = pg[def.key];
      if (f === 'active' ? !!cur === v : sameValue(cur, val)) continue;
      write[def.key] = val; expect[def.key] = cur ?? null;
      const warn = f === 'active' && v === false ? ['Seite ist danach nicht mehr erreichbar (404); Links darauf prüfen'] : f === 'content' ? ['Ersetzt den gesamten Inhalt der Seite'] : [];
      items.push({ id: `${id}:${f}`, entity: 'landing-page', entityId: id, label, field: f, fieldLabel: def.label, before: f === 'active' ? (cur ? 'ja' : 'nein') : cut(f === 'content' ? readableHtml(cur) : cur), after: f === 'active' ? (v ? 'ja' : 'nein') : cut(f === 'content' ? readableHtml(String(val)) : val), afterRaw: val, warn, ...(f === 'content' ? { html: { before: limitHtml(readableHtml(cur)).html, after: limitHtml(readableHtml(String(val))).html } } : {}) });
    }
    if (Object.keys(write).length) plans[id] = { id, write, expect };
  }
  if (!items.length) throw new Error(`Keine Änderung nötig bzw. nichts anwendbar${skipped.length ? `: ${skipped.map(s => s.reason).join('; ')}` : ''}`);
  return { cs: { id: newIdSafe(), kind: 'cms-pages', entity: 'landing-page', noun: { one: 'Seite', many: 'Seiten' }, title: a.title, reason: a.reason, items, skipped, atomic: false }, payload: { plans } };
}

/** Full state of a page for PUT (fields that Magento would otherwise reset or clear on save) */
const PAGE_KEYS = ['identifier', 'title', 'page_layout', 'meta_title', 'meta_keywords', 'meta_description', 'content_heading', 'content', 'sort_order', 'active'];
const pageBody = (cur: MRecord) => ({ id: Number(cur.id), ...Object.fromEntries(PAGE_KEYS.filter(k => k in cur).map(k => [k, cur[k]])) });

// ONE save per page with all selected fields (Magento always saves the whole page: parallel calls would overwrite each other)
reg.register('cms-pages', async (c, cs, payload, selected, ctx) => {
  const plans = (payload as { plans: Record<string, CmsPlan> }).plans, results: ApplyResult['results'] = [], undo: UndoOp[] = [];
  const byPage = new Map<string, ChangeItem[]>();
  let n = 0;
  for (const it of cs.items) if (selected.has(it.id) && it.entity !== 'info') { byPage.set(String(it.entityId), [...(byPage.get(String(it.entityId)) ?? []), it]); n++; }
  const tick = partialTicker(ctx, n, { results, undo });
  await pool([...byPage], WRITE_CONCURRENCY, async ([id, its]) => {
    try {
      const pl = plans[id]; if (!pl) throw new Error('Plan fehlt');
      const keys = its.map(it => FIELDS[String(it.field)].key), same = (k: string, a: unknown, b: unknown) => (k === 'active' ? !!a === !!b : sameValue(a, b));
      const cur = await c.req('GET', `/V1/cmsPage/${id}`, undefined, { store: 'all' }) as MRecord;
      const moved = its.filter((it, i) => !same(keys[i], cur[keys[i]], pl.expect[keys[i]]));
      if (moved.length) throw new Error(`${moved.map(m => m.fieldLabel).join(', ')} wurde inzwischen geändert, bitte neu vorschlagen`);
      // Magento always saves the whole page and rebuilds a missing URL key from the title: so always send the full state
      const data = Object.fromEntries(its.map((it, i) => [keys[i], it.afterRaw]));
      await c.req('PUT', `/V1/cmsPage/${id}`, { page: { ...pageBody(cur), ...data } }, { store: 'all' });
      undo.push(reqOp('cms-page', id, 'PUT', `/all/V1/cmsPage/${id}`, { page: { ...pageBody(cur), ...Object.fromEntries(keys.map(k => [k, cur[k] ?? (k === 'active' ? false : null)])) } }));
      const back = await c.req('GET', `/V1/cmsPage/${id}`, undefined, { store: 'all' }) as MRecord;
      const lost = its.filter((it, i) => !same(keys[i], back[keys[i]], it.afterRaw));
      if (back.identifier !== cur.identifier) lost.push({ fieldLabel: 'URL-Schlüssel' } as ChangeItem);
      if (lost.length) throw new Error(`Magento hat ${lost.map(l => l.fieldLabel).join(', ')} nicht übernommen`);
      for (const it of its) results.push({ itemId: it.id, ok: true });
    } catch (e) { for (const it of its) results.push({ itemId: it.id, ok: false, error: errMsg(e) }); }
    finally { tick(); }
  });
  return { results, undo };
});

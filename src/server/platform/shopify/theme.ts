import 'server-only';
// Shopify: theme templates for Lotse pages (Online Store 2.0, JSON templates). In the MAIN theme Lotse creates
//   sections/lotse-content.liquid            a section that outputs content from Lotse (page content or shop metafield lotse.<key>)
//   templates/page.lotse-<slug>.json         landing page: only the Lotse section (full width, page content = rendered HTML)
//   templates/collection.lotse-<slug>.json   copy of the theme's collection template + Lotse sections before/after the product list
//   templates/product.lotse-<slug>.json      copy of the product template + Lotse sections before/after the product area
// The theme's sections stay unchanged (order, settings, blocks). Pure functions here are testable;
// reading/writing theme files only in the executor (privileged client).
import { createHash } from 'node:crypto';
import type { UndoOp } from '@/lib/protocol';
import { slugify } from '@/lib/text';
import { ShopifyError, type Json, type ShopifyClient } from './client';
import { M, reqOp } from './ops';

export type TemplateKind = 'page' | 'collection' | 'product';
export const SECTION_TYPE = 'lotse-content';
export const SECTION_FILE = `sections/${SECTION_TYPE}.liquid`;
/** Files Lotse may write/delete in the theme (also in stored undo steps) */
export const LOTSE_FILE = /^(sections\/lotse-content\.liquid|templates\/(page|collection|product)\.lotse-[a-z0-9-]{1,60}\.json)$/;
/** Shopify limits: 25 sections per JSON template; metafield multi_line_text_field up to 65,000 characters */
export const MAX_SECTIONS = 25;
export const MAX_HTML = 65_000;

/** Liquid of the Lotse section. key = "page" → page content (page.content), otherwise shop metafield lotse.<key> (HTML from Lotse) */
export const SECTION_LIQUID = `{%- comment -%}
  Lotse: gibt Inhalte aus Lotse aus. Einstellung „key“: page = Inhalt der Seite, sonst Shop-Metafeld lotse.<key>.
  Wird von Lotse angelegt und verwaltet; Rückgängig in Lotse entfernt die Datei, sobald keine Vorlage sie mehr nutzt.
{%- endcomment -%}
{%- liquid
  assign key = section.settings.key
  if key == 'page'
    assign html = page.content
  elsif key != blank
    assign html = shop.metafields.lotse[key].value
  endif
-%}
{%- if html != blank -%}
  <div class="lotse-content lotse-content--{{ key | handle }}">{{ html }}</div>
{%- endif -%}

{% schema %}
{
  "name": "Lotse-Inhalt",
  "tag": "section",
  "class": "lotse-section",
  "settings": [
    { "type": "text", "id": "key", "label": "Inhalt (von Lotse verwaltet)", "info": "page = Seiteninhalt, sonst Schlüssel des Shop-Metafelds lotse.<key>" },
    { "type": "text", "id": "base", "label": "Basisvorlage (von Lotse verwaltet)", "info": "Theme-Vorlage, aus der diese Lotse-Vorlage aufgebaut wurde" }
  ]
}
{% endschema %}
`;

/** Slug for template names: lowercase, a-z0-9-, at most 50 characters */
export const templateSlug = (s: string) => slugify(s, 50);
export const suffixOf = (slug: string) => `lotse-${slug}`;
export const templateFile = (kind: TemplateKind, suffix: string | null | undefined) => `templates/${kind}${suffix ? `.${suffix}` : ''}.json`;
export const isLotseSuffix = (s: string | null | undefined) => !!s && /^lotse-[a-z0-9-]+$/.test(s);
/**
 * Key of the shop metafield (lotse.<key>, a-z0-9_-, at most 64 characters), unique per slug: up to 40 characters the slug itself,
 * longer ones truncated + hash of the whole slug (with "_", which never occurs in slugs, so no collision with short slugs)
 */
export const metaKey = (kind: TemplateKind, slug: string, part: 'before' | 'after') =>
  `${kind}-${slug.length <= 40 ? slug : `${slug.slice(0, 30)}_${createHash('sha1').update(slug).digest('hex').slice(0, 8)}`}-${part}`;

/** Read a JSON template (Shopify allows a comment block at the start) */
export function parseTemplate(text: string): Json {
  const t = JSON.parse(String(text ?? '').replace(/^\s*\/\*[\s\S]*?\*\/\s*/, ''));
  if (!t || typeof t !== 'object' || Array.isArray(t) || !t.sections || typeof t.sections !== 'object' || !Array.isArray(t.order)) throw new Error('Vorlage ist keine JSON-Vorlage mit sections/order');
  return t;
}
/** Remove Lotse sections (republishing on a Lotse template) */
export function stripLotse(tpl: Json): Json {
  const sections: Json = {}, drop = new Set<string>();
  for (const [k, v] of Object.entries(tpl.sections as Json)) { if ((v as Json)?.type === SECTION_TYPE) drop.add(k); else sections[k] = v; }
  return { ...tpl, sections, order: (tpl.order as string[]).filter(k => !drop.has(k)) };
}

const MAIN: Record<Exclude<TemplateKind, 'page'>, RegExp> = {
  collection: /(^|[-_])product[-_]grid$|^main-collection-product|collection[-_]product[-_]grid|^main-collection$/,
  product: /^main-product$|^main[-_]product|^product[-_]main$/,
};
/** Main section of the theme (product list or product area): typical name, otherwise the first "main-…" section */
export function mainSectionKey(tpl: Json, kind: Exclude<TemplateKind, 'page'>): string | null {
  const order = tpl.order as string[], type = (k: string) => String((tpl.sections as Json)[k]?.type ?? '');
  return order.find(k => MAIN[kind].test(type(k))) ?? (kind === 'collection' ? [...order].reverse() : order).find(k => /^main/.test(type(k))) ?? null;
}

/**
 * Template with Lotse sections: before directly before, after directly after the theme's main section. All theme sections stay
 * unchanged (incl. settings, blocks, layout/wrapper). Throws if no main section can be identified or the limit is exceeded.
 */
export function withLotseSections(base: Json, kind: Exclude<TemplateKind, 'page'>, parts: { before?: string | null; after?: string | null }, baseFile?: string): Json {
  const tpl = stripLotse(structuredClone(base)), main = mainSectionKey(tpl, kind);
  if (!main) throw new Error(`Die ${kind === 'collection' ? 'Kollektions' : 'Produkt'}vorlage des Themes hat keinen erkennbaren Hauptabschnitt (main-…): Lotse fügt nichts ein, um das Theme nicht zu beschädigen.`);
  const uniq = (id: string) => { let k = id, n = 2; while (k in tpl.sections) k = `${id}_${n++}`; return k; };
  const order: string[] = [], settings = (key: string) => ({ key, ...(baseFile ? { base: baseFile } : {}) });
  for (const k of tpl.order as string[]) {
    if (k === main && parts.before) { const id = uniq('lotse_before'); tpl.sections[id] = { type: SECTION_TYPE, settings: settings(parts.before) }; order.push(id); }
    order.push(k);
    if (k === main && parts.after) { const id = uniq('lotse_after'); tpl.sections[id] = { type: SECTION_TYPE, settings: settings(parts.after) }; order.push(id); }
  }
  tpl.order = order;
  if (Object.keys(tpl.sections).length > MAX_SECTIONS) throw new Error(`Die Vorlage hätte mehr als ${MAX_SECTIONS} Abschnitte (Shopify-Grenze).`);
  return tpl;
}
/** base template stored in a Lotse template (file name of a non-Lotse template) or null (older Lotse templates) */
export function storedBase(tpl: Json, kind: Exclude<TemplateKind, 'page'>): string | null {
  for (const v of Object.values(tpl.sections as Json)) {
    const b = (v as Json)?.type === SECTION_TYPE ? (v as Json).settings?.base : null;
    if (typeof b === 'string' && new RegExp(`^templates/${kind}(\\.[a-z0-9_-]+)?\\.json$`, 'i').test(b) && !/\.lotse-/.test(b)) return b;
  }
  return null;
}
/** Landing page template: only the Lotse section with the page content */
export const pageTemplate = (): Json => ({ sections: { main: { type: SECTION_TYPE, settings: { key: 'page' } } }, order: ['main'] });
export const templateText = (tpl: Json) => `${JSON.stringify(tpl, null, 2)}\n`;

// ---------------- Reading/writing (executor only, privileged client) ----------------
/** Theme write access missing (exemption/permission write_themes) */
export class ThemeAccessError extends Error { themeAccess = true as const; }
const ACCESS = /ACCESS_DENIED|exemption|access denied|not approved|write_themes/i;

export async function mainTheme(client: ShopifyClient): Promise<{ id: string; name: string }> {
  const r = await client.gql<Json>('query MainTheme { themes(first: 1, roles: [MAIN]) { nodes { id name } } }');
  const t = r.themes?.nodes?.[0]; if (!t) throw new Error('Kein veröffentlichtes Theme (MAIN) gefunden');
  return t;
}
const FILES = 'query ThemeFiles($id: ID!, $names: [String!], $first: Int!, $after: String) { theme(id: $id) { files(filenames: $names, first: $first, after: $after) { nodes { filename body { ... on OnlineStoreThemeFileBodyText { content } ... on OnlineStoreThemeFileBodyBase64 { contentBase64 } } } pageInfo { hasNextPage endCursor } } } }';
const FILE_PAGE = 250, FILE_PAGES = 40;
/** Read theme files page by page; complete = false if there would be more after FILE_PAGES pages (the caller decides "fail closed") */
export async function listThemeFiles(client: ShopifyClient, themeId: string, names: string[]): Promise<{ files: Map<string, string>; complete: boolean }> {
  const files = new Map<string, string>(); let after: string | null = null;
  for (let i = 0; i < FILE_PAGES; i++) {
    const r: Json = await client.gql<Json>(FILES, { id: themeId, names, first: FILE_PAGE, after });
    const c = r.theme?.files; if (!c) throw new Error('Theme nicht gefunden');
    for (const f of c.nodes ?? []) files.set(f.filename, f.body?.content ?? Buffer.from(f.body?.contentBase64 ?? '', 'base64').toString('utf8'));
    if (!c.pageInfo?.hasNextPage) return { files, complete: true };
    after = c.pageInfo.endCursor; if (!after) break;
  }
  return { files, complete: false };
}
/** Contents of theme files (missing files are missing from the map); placeholders like templates/*.json allowed */
export async function readThemeFiles(client: ShopifyClient, themeId: string, names: string[]): Promise<Map<string, string>> {
  const { files, complete } = await listThemeFiles(client, themeId, names);
  if (!complete) throw new Error('Theme-Dateien konnten nicht vollständig gelesen werden');
  return files;
}

async function themeMutation(client: ShopifyClient, query: string, variables: Json, root: string): Promise<Json> {
  let d: Json;
  try { d = await client.gql<Json>(query, variables); }
  catch (e) { if (e instanceof ShopifyError && (e.code === 'ACCESS_DENIED' || ACCESS.test(e.message))) throw new ThemeAccessError(themeHint(e.message)); throw e; }
  const p = d[root], errs: Json[] = p?.userErrors ?? [];
  if (errs.length) {
    const msg = errs.map(x => `${x.filename ? `${x.filename}: ` : ''}${x.message}`).join('; ');
    if (errs.some(x => x.code === 'ACCESS_DENIED' || ACCESS.test(x.message ?? ''))) throw new ThemeAccessError(themeHint(msg));
    throw new ShopifyError(`Shopify: ${msg}`, 200, 'USER_ERROR');
  }
  return p;
}
const themeHint = (m: string) => `Lotse darf das Theme nicht schreiben (${m.slice(0, 200)}). Shopify verlangt dafür die Berechtigung write_themes und für Apps eine Freigabe (Theme-Exemption).`;

/** Write a file + undo: existed before → write back the old content, otherwise delete */
export async function upsertThemeFile(client: ShopifyClient, themeId: string, filename: string, content: string, prior: string | undefined, undo: UndoOp[]) {
  if (!LOTSE_FILE.test(filename)) throw new Error(`Lotse schreibt nur eigene Theme-Dateien (${filename} abgelehnt)`);
  // shared section already there (e.g. from another Lotse page): on undo only delete it if no template uses it anymore by then
  if (prior === content) { if (filename === SECTION_FILE) undo.push({ op: 'delete', entity: 'theme-section', id: themeId, data: { filename } }); return; }
  const back: UndoOp = prior != null ? reqOp('theme-file', themeId, M.themeFilesUpsert, { themeId, files: [{ filename, body: { type: 'TEXT', value: prior } }] })
    : filename === SECTION_FILE ? { op: 'delete', entity: 'theme-section', id: themeId, data: { filename } } : reqOp('theme-file', themeId, M.themeFilesDelete, { themeId, files: [filename] });
  // Record the undo even on unclear outcome (network, timeout); on userErrors/missing write permission Shopify changed nothing
  try { await themeMutation(client, M.themeFilesUpsert, { themeId, files: [{ filename, body: { type: 'TEXT', value: content } }] }, 'themeFilesUpsert'); }
  catch (e) { if (!(e instanceof ThemeAccessError || (e instanceof ShopifyError && e.code === 'USER_ERROR'))) undo.push(back); throw e; }
  undo.push(back);
}

/** check after writing (Shopify writes theme files as a job, follow up briefly) */
export async function verifyThemeFile(client: ShopifyClient, themeId: string, filename: string, content: string, sleep = (ms: number) => new Promise(r => setTimeout(r, ms))) {
  for (let i = 0; i < 6; i++) {
    if ((await readThemeFiles(client, themeId, [filename])).get(filename) === content) return;
    await sleep(500 * (i + 1));
  }
  throw new Error(`Prüfung fehlgeschlagen: ${filename} hat im Theme nicht den geschriebenen Inhalt`);
}

/** Templates and section groups that can use a section (including ones inserted by hand into non-Lotse templates) */
export const SECTION_USERS = ['templates/*.json', 'templates/customers/*.json', 'templates/metaobject/*.json', 'sections/*.json'];
/**
 * Undo for sections/lotse-content.liquid: only delete if no template of the theme uses the section anymore.
 * Read page by page; if the list is incomplete, the section stays (fail closed: better an unused file than broken pages).
 */
export async function deleteSectionIfUnused(client: ShopifyClient, themeId: string): Promise<void> {
  const { files, complete } = await listThemeFiles(client, themeId, SECTION_USERS);
  const used = [...files.values()].some(t => t.includes(`"${SECTION_TYPE}"`));
  if (used || !complete) return; // other templates still use the section: it stays (harmless, outputs nothing without content)
  try { await themeMutation(client, M.themeFilesDelete, { themeId, files: [SECTION_FILE] }, 'themeFilesDelete'); }
  catch (e) { if (!/does not exist|not found|NOT_FOUND/i.test(e instanceof Error ? e.message : String(e))) throw e; }
}

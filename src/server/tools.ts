import 'server-only';
import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { ChatEvent, Styleguide } from '@/lib/protocol';
import type { PlatformKind } from '@/lib/platforms';
import { blocksFor, validateSpec, renderPreview, type ImageRef, type PageSpec, type PageType } from './cms';
import { downloadImage, readStaged, stageFromUrl, stageImage, sanitizeSvg, generateRaster, imageGenAvailable, type StagedResult } from './media';
import { expandSpec, PATTERNS, unknownPatterns } from './patterns';
import { auditSpec, auditSummary } from './audit';
import { unsupportedBlocks } from './page-html';
import { loadStyleguide, saveStyleguide } from './styleguide';
import { getPlatform } from './platform';
import { PUBLISH_PAGE_TYPE, type PlatformAdapter, type PublishTarget } from './platform/types';
import { persist, type Session } from './sessions';

import { ok, fail, guard, type AnyTool } from './tool-kit';
import { FEATURES } from './features';
import type { Feature } from './features/types';
// Image event for the UI (alt: null → omit, see protocol.ts)
const imageEvent = (m: StagedResult) => ({ t: 'image' as const, ...m, alt: m.alt ?? undefined });

// Connects session state (platform read client, draft, UI events) with the agent tools, provider-neutral (Claude: in-process MCP, Codex: MCP over HTTP).
// Core tools here; platform-specific ones in the adapter (platform/<kind>/), feature areas in features/ (Feature.platforms).
/** Version of the preview renderer (product boxes, patterns …); bump when the appearance changes. */
export const PREVIEW_VERSION = 6;

/** Re-renders the preview of a chat's last draft with the current renderer (once per version). */
export async function refreshDraftPreview(session: Session): Promise<boolean> {
  if (session.running) return false;
  const ev = [...session.events].reverse().find((e): e is Extract<ChatEvent, { t: 'draft' }> => e.t === 'draft' && !!e.spec);
  if (!ev || ev.rv === PREVIEW_VERSION) return false;
  installRenderDraft(session, getPlatform(session.platform)); // fresh render function (current renderer) without building all tools
  try { ev.html = await session.renderDraft!(ev.spec as PageSpec); ev.rv = PREVIEW_VERSION; persist(session); return true; }
  catch { return false; } // shop unreachable or similar: keep the old preview
}

/** Order of tools in the catalog (core + platform mixed as they grew); unknown ones follow in their own order. */
const TOOL_ORDER = ['list_sales_channels', 'search_categories', 'search_products', 'get_product', 'get_category', 'search_media', 'list_cms_pages', 'get_cms_page', 'read_page', 'import_image', 'create_svg_image', 'generate_image', 'get_styleguide', 'get_brand_signals', 'save_styleguide', 'draft_page', 'ask_user', 'list_products', 'propose_product_changes', 'view_image', 'propose_new_products', 'propose_category_changes', 'publish_page'];
const rank = (n: string) => { const i = TOOL_ORDER.indexOf(n); return i < 0 ? TOOL_ORDER.length : i; };
const byOrder = <T>(list: T[], name: (x: T) => string) => list.map((x, i) => ({ x, i })).sort((a, b) => rank(name(a.x)) - rank(name(b.x)) || a.i - b.i).map(e => e.x);

export const CORE_TOOL_NAMES = ['import_image', 'create_svg_image', 'generate_image', 'get_styleguide', 'save_styleguide', 'draft_page', 'ask_user', 'view_image', 'publish_page'];

/** Feature modules of a platform: core (platforms 'all') + those marked for it + the adapter's own */
export const featuresFor = (p: Pick<PlatformAdapter, 'kind' | 'features'>): Feature[] => [...FEATURES.filter(f => f.platforms === 'all' || f.platforms.includes(p.kind)), ...(p.features ?? [])];

/** The session's render function: draft → preview HTML (final: with the platform's product/media context; partial: fast, without shop queries) */
export function installRenderDraft(session: Session, p: PlatformAdapter) {
  const pages = p.pages;
  session.renderDraft = async (spec: PageSpec, partial = false) => {
    const ctx = partial ? (session.lastCtx ?? { imageUrl: (im: ImageRef) => (typeof im === 'string' ? im : im?.url) }) : (session.lastCtx = await pages.previewData(session, spec));
    return renderPreview(expandSpec(spec), { ...ctx, themeCss: await session.themeCss?.() });
  };
}

function coreTools(session: Session, p: PlatformAdapter): AnyTool[] {
  const { emit } = session, caps = p.capabilities, pages = p.pages;
  const blockSchema = z.object({ type: z.string().describe(`Einer von: ${blocksFor(caps.blocks).join(', ')} – oder "pattern" (dann pattern + data, siehe Pattern-Katalog)`) }).passthrough();
  const specShape = {
    name: z.string().describe('Name des CMS-Layouts (intern)'),
    type: z.enum(caps.pageTypes as [PageType, ...PageType[]]),
    sections: z.array(z.object({
      type: z.enum(['default', 'sidebar']).optional(),
      sizingMode: z.enum(['boxed', 'full_width']).optional(),
      backgroundColor: z.string().optional(),
      blocks: z.array(blockSchema),
    })),
    seo: z.object({ keyword: z.string().describe('Fokus-Keyword mit Suchintention'), metaTitle: z.string().describe('30–60 Zeichen, Keyword vorn, Nutzen/Marke'), metaDescription: z.string().describe('120–158 Zeichen, Keyword + Nutzen + CTA') }).optional().describe('SEO-Metadaten – immer setzen'),
    previewCategoryId: z.string().optional().describe('Nur Vorschau: Kategorie, aus der Beispielprodukte geladen werden'),
    previewProductId: z.string().optional().describe('Nur Vorschau: Produkt für dynamische PDP-Bausteine'),
  };

  installRenderDraft(session, p);

  return [
    tool('import_image', `Holt ein Bild von einer URL (vom Nutzer genannt) und merkt es lokal VOR. Es landet erst nach Freigabe der Veröffentlichung in der ${p.label}-Medienbibliothek. Liefert eine mediaId ("staged:…") zur Verwendung als image:{mediaId, alt}.`,
      { url: z.string().url(), alt: z.string().describe('Aussagekräftiger Alt-Text'), name: z.string().optional() }, guard(async ({ url, alt, name }) => {
        const m = await stageFromUrl(url, { alt, name: name ?? alt }); emit(imageEvent(m)); return ok(m);
      })),

    tool('create_svg_image', 'Erstellt eine Vektorgrafik (Illustration, Icon-Set, Banner-Hintergrund, Infografik, Muster) aus SVG-Code und merkt sie lokal vor (Upload erst nach Freigabe). Nutze Styleguide-Farben (Hex), viewBox, KEINE Scripts/externen Referenzen, Text nur wenn nötig (Schrift = system-ui). Für Fotos ungeeignet. Liefert mediaId "staged:…".',
      { svg: z.string().describe('Vollständiges <svg …>…</svg>'), alt: z.string(), name: z.string().optional() }, guard(async ({ svg, alt, name }) => {
        const m = stageImage(Buffer.from(sanitizeSvg(svg)), 'image/svg+xml', { name: name ?? alt, alt }); emit(imageEvent(m)); return ok(m);
      })),

    tool('generate_image', imageGenAvailable() ? 'Erzeugt ein Foto/Key-Visual per KI aus einem Prompt und merkt es lokal vor (Upload erst nach Freigabe). Prompt auf Englisch, konkret (Motiv, Stil, Licht, Komposition, Farbwelt laut Styleguide), KEIN Text im Bild, keine Logos/Marken/erkennbare Personen. Dauert ~30–60 s.' : 'Bild-KI ist hier NICHT konfiguriert (Einstellungen → Bild-KI). Der Aufruf liefert einen Fehler. Nutze stattdessen Shop-Medien, Nutzer-Uploads oder create_svg_image.',
      { prompt: z.string(), alt: z.string(), size: z.enum(['1536x1024', '1024x1024', '1024x1536']).optional(), name: z.string().optional() }, guard(async ({ prompt, alt, size, name }) => {
        const buf = await generateRaster(prompt, size ?? '1536x1024');
        const m = stageImage(buf, 'image/png', { name: name ?? alt, alt, ai: true }); emit(imageEvent(m));
        return ok({ ...m, aiGenerated: true, hinweis: 'KI-generiertes Bild: muss sichtbar gekennzeichnet sein. Muster (hero/split/band) setzen „Bild: KI-generiert“ automatisch; in custom-html selbst eine Bildzeile „Bild: KI-generiert“ ergänzen.' });
      })),

    tool('get_styleguide', 'Liest den gespeicherten Shop-Styleguide (Farben, Typografie, Formen, Tonalität). Null, wenn noch keiner existiert.', {}, guard(async () => ok(loadStyleguide() ?? 'Kein Styleguide vorhanden.'))),

    tool('save_styleguide', 'Speichert/überschreibt den Shop-Styleguide. Immer den VOLLSTÄNDIGEN Styleguide senden. Farben als Hex (#rrggbb). Danach wirkt er in allen Entwürfen (Texte, Farben, custom-html-Variablen, Vorschau).', {
      brandName: z.string(), summary: z.string().describe('2–3 Sätze: Markencharakter, Zielgruppe, Positionierung'),
      colors: z.object({ primary: z.string(), primaryContrast: z.string(), secondary: z.string().optional(), accent: z.string().optional(), text: z.string(), muted: z.string().optional(), background: z.string(), surface: z.string().optional(), border: z.string().optional() }).describe('primary = Buttons/Links/Hauptakzent'),
      typography: z.object({ headingFont: z.string(), bodyFont: z.string(), baseSize: z.string().optional(), headingWeight: z.string().optional(), notes: z.string().optional() }),
      shape: z.object({ radius: z.string(), buttons: z.string().describe('Beschreibung des Button-Stils'), shadow: z.string().optional() }),
      logoUrl: z.string().optional(), imagery: z.string().describe('Bildstil/-motive'),
      tone: z.object({ formality: z.enum(['Du', 'Sie']), voice: z.string(), dos: z.array(z.string()), donts: z.array(z.string()), examples: z.array(z.string()).describe('2–4 Beispielsätze im Markenton') }),
      layoutNotes: z.string().optional().describe('Rhythmus, Weißraum, typische Seitenmuster (Abschnittsfolge der Startseite/Kategorien/Produktseiten)'),
      components: z.object({ buttons: z.string().optional(), headings: z.string().optional(), cards: z.string().optional(), sections: z.string().optional(), notes: z.string().optional() }).optional().describe('Lokale Notiz zu Buttons, Überschriften, Karten und Abschnitten. Wird nur im Styleguide gespeichert, zusammen mit Farben, Typografie und Tonalität.'),
      existingBlocks: z.array(z.string()).optional().describe('Lokale Notizen zu wiederkehrenden Seitenelementen. Werden nur im Styleguide gespeichert, zusammen mit Farben, Typografie und Tonalität.'),
    }, guard(async (sg: Styleguide) => { const saved = saveStyleguide(sg); if (saved) emit({ t: 'styleguide', sg: saved }); return ok('Styleguide gespeichert.'); })),

    tool('draft_page', `Erstellt/ersetzt den Seitenentwurf und zeigt ihn dem Nutzer sofort in der Vorschau. Noch NICHTS in ${p.label} geschrieben. Beliebig oft aufrufbar zum Iterieren – immer die komplette Spec senden.`,
      specShape, guard(async (input: z.infer<z.ZodObject<typeof specShape>>) => {
        const prep = pages.prepareDraft ? await pages.prepareDraft(session, input as PageSpec) : { spec: input as PageSpec, links: null };
        if (prep.errors?.length) return fail(prep.errors.join('; '));
        const raw = prep.spec, links = prep.links ?? null;
        const unknown = unknownPatterns(raw);
        if (unknown.length) return fail(`Unbekannte(s) Pattern ${unknown.map(n => `"${n}"`).join(', ')} (erlaubt: ${Object.keys(PATTERNS).join(', ')})`);
        const spec = expandSpec(raw);
        const allowed = blocksFor(caps.blocks);
        const errs = validateSpec(spec, { layoutRules: caps.pageFormat === 'cms', themeMain: allowed.includes('theme-main') });
        if (!caps.pageTypes.includes(spec.type)) errs.push(`type=${spec.type} gibt es in ${p.label} nicht (erlaubt: ${caps.pageTypes.join(', ')})`);
        const bad = unsupportedBlocks(spec, allowed);
        if (bad.length) errs.push(`Blocktyp(en) ${bad.join(', ')} gibt es in ${p.label} nicht (erlaubt: ${allowed.join(', ')} und pattern)`);
        if (errs.length) return fail(errs.join('; '));
        session.draft = spec;
        const audit = auditSpec(spec, links, { format: caps.pageFormat });
        const html = await session.renderDraft!(raw);
        emit({ t: 'draft', html, spec: raw, name: spec.name, pageType: spec.type, audit, rv: PREVIEW_VERSION });
        const focus = await pages.focus?.(session, raw); if (focus) emit(focus);
        return ok(`Entwurf "${spec.name}" (${spec.type}, ${spec.sections.reduce((n, s) => n + s.blocks.length, 0)} Blöcke) ist in der Vorschau sichtbar.${links?.rewrites.size ? ` ${links.rewrites.size} technische(r) Link(s) durch SEO-URLs ersetzt.` : ''}\n${auditSummary(audit)}\nVerbessere Punkte mit "wichtig" (höchstens 2 Überarbeitungsrunden), danach fasse dem Nutzer ehrlich zusammen, was erreicht ist und was offen bleibt.`);
      })),

    tool('ask_user', 'RÜCKFRAGE an den Nutzer mit anklickbaren Antworten (der Nutzer kann stattdessen frei tippen). Der Aufruf wartet auf die Antwort und liefert sie als Text. Nutzen: (a) vor jeder Änderung (Preise/Daten/Texte/Veröffentlichung) kurz zurückspiegeln "Ich verstehe: … Betrifft: … Stimmt das?", (b) mehrdeutige Ziele/Mehrfachtreffer auswählen lassen, (c) fehlende Pflichtangaben erfragen. NICHT nutzen für reine Analysen oder Seitenentwürfe (die sind folgenlos). Pro Aufruf genau EINE klare Frage, 2–4 Optionen, Standard zuerst.',
      { question: z.string().describe('Kurze, konkrete Frage; bei Bestätigung: Verständnis + Umfang + Regel zusammenfassen (Markdown erlaubt)'), options: z.array(z.object({ label: z.string(), description: z.string().optional() })).min(1).max(5).describe('z.B. [{label:"Ja, Vorschlag erstellen"},{label:"Anpassen …"}]') },
      guard(async a => ok({ answer: await session.askUser(a) }))),

    tool('view_image', 'Bild ANSEHEN (z. B. ein hochgeladenes Produktfoto), um Produkt, Material, Farbe, Form und Details zu erkennen. Eingabe: mediaId aus einem Anhang/der Medienverwaltung, „staged:…“ oder eine Bild-URL des Shops bzw. aus dem öffentlichen Internet (keine internen Adressen).',
      { mediaId: z.string().optional(), url: z.string().optional() }, guard(async ({ mediaId, url }) => {
        let buf: Buffer, mime: string, src = url ?? '';
        const stagedId = mediaId?.startsWith('staged:') ? mediaId.slice(7) : url?.match(/^\/staged\/([a-z0-9]+)\.[a-z0-9]+$/i)?.[1]; // also the preview URL "/staged/<id>.png"
        if (stagedId) {
          const m = readStaged(stagedId); if (!m) throw new Error('Vorgemerktes Bild nicht gefunden');
          ({ buf, mime } = m); src = m.name;
        } else {
          if (mediaId) { const u = await session.lookup.mediaUrl(mediaId); if (!u) throw new Error('Medium nicht gefunden'); src = u; }
          if (!src) throw new Error('mediaId oder url angeben');
          ({ buf, mime } = await downloadImage(src));
        }
        if (buf.length > 5 * 1024 * 1024) throw new Error('Bild größer als 5 MB: bitte kleiner hochladen');
        if (!/^image\/(jpeg|png|webp|gif)$/.test(mime)) throw new Error(`Bildtyp ${mime} kann nicht angesehen werden`);
        return { content: [{ type: 'image', data: buf.toString('base64'), mimeType: mime }, { type: 'text', text: `Bild: ${src}` }] };
      })),

    tool('publish_page', pages.publishTool.description, pages.publishTool.shape, guard(async (a: Record<string, unknown>) => {
      const spec = session.draft;
      if (!spec) return fail('Kein Entwurf vorhanden: zuerst draft_page aufrufen.');
      const target = a.target as PublishTarget;
      if (!caps.publishTargets.includes(target)) return fail(`target=${String(a.target)} geht in ${p.label} nicht (möglich: ${caps.publishTargets.join(', ')}).`);
      const need = PUBLISH_PAGE_TYPE[target], allowed = target === 'category' ? (caps.categoryPageTypes ?? [need]) : [need];
      if (!allowed.includes(spec.type)) return fail(`Entwurfstyp ${spec.type} passt nicht zu target=${a.target} (erwartet ${allowed.join(' oder ')}).`);
      const { cs, payload } = await pages.buildPublish(session, spec, a);
      return ok(await session.requestChange(cs, payload));
    })),
  ] as AnyTool[];
}

export function buildTools(session: Session): AnyTool[] {
  const p = getPlatform(session.platform);
  const own = byOrder([...coreTools(session, p), ...p.tools(session)], t => t.name);
  return [...own, ...featuresFor(p).flatMap(f => f.tools(session))];
}
export type ShopTool = ReturnType<typeof buildTools>[number];

/** Claude: tools as in-process MCP server "shop". */
export const buildToolServer = (session: Session) => createSdkMcpServer({ name: 'shop', version: '1.0.0', tools: buildTools(session) });

/** Names of all tools of a platform (allowlist for the agent) */
export const toolNamesFor = (kind: PlatformKind): string[] => {
  const p = getPlatform(kind);
  return [...byOrder([...CORE_TOOL_NAMES, ...p.toolNames], n => n), ...featuresFor(p).flatMap(f => f.toolNames)];
};
export const allToolsFor = (kind: PlatformKind): string[] => toolNamesFor(kind).map(n => `mcp__shop__${n}`);
/** Shopware (default), for tests and legacy calls */
export const TOOL_NAMES: string[] = toolNamesFor('shopware');

import 'server-only';
// Vertrag einer Shop-Plattform (Adapter). Ausführlich beschrieben in docs/platform.md.
// Der Kern (Chat, Freigabe-Workflow, Vorschau, Wissensbasis, Search Console, Shop-Check) spricht NUR über diese Schnittstelle mit dem Shop.
import type { ZodRawShape } from 'zod';
import type { CategoryRow, ChangeSet, ChatEvent, PlatformPaths, ProductRow, TestResult, UndoOp } from '@/lib/protocol';
import type { PlatformKind, PlatformSettingsDescriptor } from '@/lib/platforms';
import type { ApplyCtx, ApplyResult } from '../changes';
import type { ShopCheck } from '../checks';
import type { PageSpec, PageType, PreviewCtx } from '../cms';
import type { Feature } from '../features/types';
import type { PageRef } from '../features/gsc-map';
import type { LinkKind, LinkReport } from '../seo-links';
import type { Session } from '../sessions';
import type { AnyTool } from '../tool-kit';
import type { Fetcher } from '../styleguide';

export type { PlatformKind } from '@/lib/platforms';

/** Ziele von publish_page: category = Kategorie/Kollektion, product = Produkt(e), landingpage = eigene Seite mit URL */
export type PublishTarget = 'category' | 'product' | 'landingpage';
/** Seitentyp des Entwurfs je Ziel (gilt für alle Plattformen) */
export const PUBLISH_PAGE_TYPE: Record<PublishTarget, PageType> = { category: 'product_list', product: 'product_detail', landingpage: 'landingpage' };

/**
 * Was eine Plattform kann. draft_page/publish_page prüfen dagegen, der Prompt beschreibt es (Blockkatalog, Seitentypen).
 * blocks: 'all' = alle BLOCKS aus cms.ts (Shopware-Einkaufswelten); sonst die erlaubten Blocktypen (siehe GENERIC_BLOCKS) – "pattern" ist immer erlaubt.
 * pageFormat: 'cms' = Layout mit Sections/Blöcken (Shopware), 'html' = die Seite wird als statisches HTML veröffentlicht (renderPageHtml in page-html.ts).
 */
export interface PlatformCapabilities {
  pageTypes: readonly PageType[];
  publishTargets: readonly PublishTarget[];
  blocks: 'all' | readonly string[];
  pageFormat: 'cms' | 'html';
  /** reuse-Blöcke (bestehende Blöcke 1:1 übernehmen) */
  reuse: boolean;
}

/** Datensatz einer Plattform, je Entität dynamisch – bewusst lose typisiert */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LooseRecord = Record<string, any>;

export interface ProductFacts { id: string; number?: string; name?: string; ean?: string; categoryIds: string[] }

/**
 * Plattform-neutrale Lesefunktionen für Kern-Funktionen (Wissensbasis, Search Console, view_image).
 * Liest IMMER über den geschützten Lese-Client der Session (Freigabeliste der Plattform), nie über den privilegierten Client.
 */
export interface ShopLookup {
  /** Produkte per ID und/oder Artikelnummer (SKU); Reihenfolge: erst Treffer der IDs, dann der Nummern */
  findProducts(q: { ids?: string[]; numbers?: string[] }): Promise<{ id: string; number?: string; name?: string }[]>;
  findCategories(ids: string[]): Promise<{ id: string; name?: string }[]>;
  /** Produkt-Kerndaten (Wissensbasis: Nummer, EAN, Name, Kategorien inkl. Eltern) */
  getProduct(id: string): Promise<ProductFacts | null>;
  /** öffentliche URL eines Mediums der Plattform (Medien-ID wie in den Werkzeugen) */
  mediaUrl(id: string): Promise<string | undefined>;
  /** Seiten-URLs (Search Console) → Shop-Entität; nicht zuordenbar = null. metas: aktuelle metaTitle/metaDescription mitliefern */
  mapUrls(urls: string[], o?: { metas?: boolean }): Promise<Map<string, PageRef | null>>;
  /** URL-Pfade (ohne Domain, ohne führenden Slash) und absolute URLs einer Entität */
  entityPaths(kind: LinkKind, id: string): Promise<{ paths: string[]; urls: string[] }>;
  /** aktueller Datensatz für Drift-Prüfungen: Feldwerte direkt oder unter translated (entity: product | category | landing-page) */
  current(entity: string, id: string): Promise<LooseRecord | null>;
}

/** Was eine Session von der Plattform bekommt (je Chat einmal angelegt). */
export interface PlatformSessionParts {
  /** geschützter Lese-Client der KI (Freigabeliste, Bereinigung, Zugriffsprotokoll) */
  reader: unknown;
  lookup: ShopLookup;
  storefrontFetch: Fetcher;
  themeCss: () => Promise<string | null>;
}

/** Seiten: Vorschau-Daten, Entwurfs-Vorbereitung und Veröffentlichung */
export interface PlatformPages {
  /** Produkte/Medien für die Vorschau: products nach ID (Name, Preis formatiert, Bild-URL, url), product = previewProductId, imageUrl löst ImageRefs auf */
  previewData(session: Session, spec: PageSpec): Promise<PreviewCtx>;
  /** vor dem Rendern: plattformspezifische Auflösung (Shopware: reuse-Blöcke, technische Links → SEO-URLs). errors → draft_page schlägt fehl */
  prepareDraft?(session: Session, spec: PageSpec): Promise<{ spec: PageSpec; links?: LinkReport | null; errors?: string[] }>;
  /** Fokus-Ereignis (Produkt/Kategorie der Vorschau) für die Oberfläche */
  focus?(session: Session, spec: PageSpec): Promise<ChatEvent | null>;
  /** Beschreibung + Felder des Werkzeugs publish_page (zod-Shape) */
  publishTool: { description: string; shape: ZodRawShape };
  /** Änderungsset (kind „page“ o. Ä.) + Payload für den Applier; wirft bei fehlenden Angaben (Text geht an die KI) */
  buildPublish(session: Session, spec: PageSpec, args: Record<string, unknown>): Promise<{ cs: ChangeSet; payload: unknown }>;
}

/** Daten für die Kontext-Auswahl (/api/categories, /api/products) – Anzeige für den Menschen, nicht für die KI */
export interface PlatformContext {
  categories(): Promise<CategoryRow[]>;
  products(q: { term?: string | null; categoryId?: string | null }): Promise<ProductRow[]>;
}

export interface PlatformAdapter {
  kind: PlatformKind;
  label: string;
  settings: PlatformSettingsDescriptor;
  capabilities: PlatformCapabilities;
  /** Platzhalter in prompts/common/*.md und im Blockkatalog: {{shop}} (z. B. „Shopware-6-Shop“), {{platform}} („Shopware“), {{htmlElement}} (custom-html, z. B. „Shopware-HTML-Element“), {{shopcheckTools}} (Lese-Werkzeuge für Shop-Check-Aufträge, mit führendem Leerzeichen und Klammern, oder leer) */
  promptVars: Record<string, string>;
  /** Zugang vollständig (Einstellungen) */
  configured(): boolean;
  /** nach Änderung der Einstellungen: Clients/Caches neu aufbauen */
  reconfigure(): void;
  /** „Verbindung testen“ in den Einstellungen */
  testConnection(): Promise<TestResult>;
  /** Statuszeile (Seitenleiste): erreichbar + Anzeige-URL */
  health(): Promise<{ url: string; ok: boolean; error?: string }>;
  /** Admin-/Storefront-Basis und Pfad-Vorlagen für Links in der Oberfläche */
  urls(): Promise<{ admin: string; storefront: string; paths: PlatformPaths }>;
  /** Lese-Client + Lookup für eine Session bzw. den Shop-Check (chat = Name im Zugriffsprotokoll) */
  openSession(chat: string): PlatformSessionParts;
  /** ShopLookup über einen (geschützten) Lese-Client dieser Plattform, z. B. den des Shop-Check-Durchlaufs */
  lookup(reader: unknown): ShopLookup;
  /** Werkzeugnamen und Werkzeuge der Plattform (ohne Kern- und Feature-Werkzeuge) */
  toolNames: string[];
  tools(session: Session): AnyTool[];
  /** zusätzliche Feature-Module dieser Plattform (außerhalb von features/index.ts); dort registrierte Module wählen ihre Plattform über Feature.platforms */
  features?: Feature[];
  /** lädt die Module, die Shop-Prüfungen registrieren (registerCheck mit platforms) */
  loadChecks(): Promise<void>;
  /** Freigegebenes Änderungsset schreiben (privilegierter Client, nur hier) */
  apply(cs: ChangeSet, payload: unknown, selected: Set<string>, ctx?: ApplyCtx): Promise<ApplyResult>;
  /** Rückgängig: UndoOps dieser Plattform in umgekehrter Reihenfolge ausführen */
  undo(ops: UndoOp[]): Promise<{ ok: boolean; error?: string }[]>;
  pages: PlatformPages;
  context: PlatformContext;
  /** Storefront für den Vorschau-Proxy /shop (Basis-URL + Abruf über die interne Adresse) */
  storefront: { base(): Promise<string>; fetch: Fetcher };
}

export type { ShopCheck };

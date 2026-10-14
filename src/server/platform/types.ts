import 'server-only';
// Contract of a shop platform (adapter). Described in detail in docs/platform.md.
// The core (chat, approval workflow, preview, knowledge base, Search Console, shop check) talks to the shop ONLY via this interface.
import type { ZodRawShape } from 'zod';
import type { CategoryRow, ChangeSet, ChatEvent, PlatformPaths, ProductRow, TestResult, UndoOp } from '@/lib/protocol';
import type { PlatformKind, PlatformSettingsDescriptor } from '@/lib/platforms';
import type { ApplyCtx, ApplyResult } from '../changes';
import type { NeutralScan } from '@/lib/custom-checks';
import type { ShopCheck } from '../checks';
import type { PageSpec, PageType, PreviewCtx } from '../cms';
import type { Feature } from '../features/types';
import type { PageRef } from '../features/gsc-map';
import type { LinkKind, LinkReport } from '../seo-links';
import type { Session } from '../sessions';
import type { AnyTool } from '../tool-kit';
import type { Fetcher } from '../styleguide';

export type { PlatformKind } from '@/lib/platforms';

/** Targets of publish_page: category = category/collection, product = product(s), landingpage = standalone page with URL */
export type PublishTarget = 'category' | 'product' | 'landingpage';
/** Draft page type per target (applies to all platforms) */
export const PUBLISH_PAGE_TYPE: Record<PublishTarget, PageType> = { category: 'product_list', product: 'product_detail', landingpage: 'landingpage' };

/**
 * What a platform can do. draft_page/publish_page check against it, the prompt describes it (block catalog, page types).
 * blocks: 'all' = all BLOCKS from cms.ts (Shopware Shopping Experiences); otherwise the allowed block types (see GENERIC_BLOCKS); "pattern" is always allowed.
 * pageFormat: 'cms' = layout with sections/blocks (Shopware), 'html' = the page is published as static HTML (renderPageHtml in page-html.ts).
 */
export interface PlatformCapabilities {
  pageTypes: readonly PageType[];
  publishTargets: readonly PublishTarget[];
  /** Draft types that may be assigned to a category (default: only product_list); Shopware: also landingpage (home page, shop pages) */
  categoryPageTypes?: readonly PageType[];
  blocks: 'all' | readonly string[];
  pageFormat: 'cms' | 'html';
  /** reuse blocks (take over existing blocks 1:1) */
  reuse: boolean;
}

/** A platform record, dynamic per entity, deliberately loosely typed */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LooseRecord = Record<string, any>;

export interface ProductFacts { id: string; number?: string; name?: string; ean?: string; categoryIds: string[] }

/**
 * Platform-neutral read functions for core features (knowledge base, Search Console, view_image).
 * ALWAYS reads via the session's protected read client (the platform's allowlist), never via the privileged client.
 */
export interface ShopLookup {
  /** Products by ID and/or SKU; order: first the ID matches, then the SKU matches */
  findProducts(q: { ids?: string[]; numbers?: string[] }): Promise<{ id: string; number?: string; name?: string }[]>;
  findCategories(ids: string[]): Promise<{ id: string; name?: string }[]>;
  /** Core product data (knowledge base: SKU, EAN, name, categories incl. parents) */
  getProduct(id: string): Promise<ProductFacts | null>;
  /** public URL of a platform media item (media ID as in the tools) */
  mediaUrl(id: string): Promise<string | undefined>;
  /** Page URLs (Search Console) → shop entity; unmappable = null. metas: also return current metaTitle/metaDescription */
  mapUrls(urls: string[], o?: { metas?: boolean }): Promise<Map<string, PageRef | null>>;
  /** URL paths (without domain, without leading slash) and absolute URLs of an entity */
  entityPaths(kind: LinkKind, id: string): Promise<{ paths: string[]; urls: string[] }>;
  /** current record for drift checks: field values directly or under translated (entity: product | category | landing-page) */
  current(entity: string, id: string): Promise<LooseRecord | null>;
}

/** What a session gets from the platform (created once per chat). */
export interface PlatformSessionParts {
  /** the AI's protected read client (allowlist, sanitization, access log) */
  reader: unknown;
  lookup: ShopLookup;
  storefrontFetch: Fetcher;
  themeCss: () => Promise<string | null>;
}

/** Pages: preview data, draft preparation and publishing */
export interface PlatformPages {
  /** Products/media for the preview: products by ID (name, formatted price, image URL, url), product = previewProductId, imageUrl resolves ImageRefs */
  previewData(session: Session, spec: PageSpec): Promise<PreviewCtx>;
  /** before rendering: platform-specific resolution (Shopware: reuse blocks, technical links → SEO URLs). errors → draft_page fails */
  prepareDraft?(session: Session, spec: PageSpec): Promise<{ spec: PageSpec; links?: LinkReport | null; errors?: string[] }>;
  /** Focus event (product/category of the preview) for the UI */
  focus?(session: Session, spec: PageSpec): Promise<ChatEvent | null>;
  /** Description + fields of the publish_page tool (zod shape) */
  publishTool: { description: string; shape: ZodRawShape };
  /** Change set (kind "page" or similar) + payload for the applier; throws on missing details (the text goes to the AI) */
  buildPublish(session: Session, spec: PageSpec, args: Record<string, unknown>): Promise<{ cs: ChangeSet; payload: unknown }>;
}

/** Data for the context picker (/api/categories, /api/products): display for the human, not for the AI */
export interface PlatformContext {
  categories(): Promise<CategoryRow[]>;
  products(q: { term?: string | null; categoryId?: string | null }): Promise<ProductRow[]>;
}

export interface PlatformAdapter {
  kind: PlatformKind;
  label: string;
  settings: PlatformSettingsDescriptor;
  capabilities: PlatformCapabilities;
  /** Placeholders in prompts/common/*.md and in the block catalog: {{shop}} (e.g. "Shopware-6-Shop"), {{platform}} ("Shopware"), {{htmlElement}} (custom-html, e.g. "Shopware-HTML-Element"), {{shopcheckTools}} (read tools for shop check tasks, with leading space and parentheses, or empty) */
  promptVars: Record<string, string>;
  /** Credentials complete (settings) */
  configured(): boolean;
  /** after settings change: rebuild clients/caches */
  reconfigure(): void;
  /** "Verbindung testen" (test connection) in the settings */
  testConnection(): Promise<TestResult>;
  /** Status line (sidebar): reachable + display URL */
  health(): Promise<{ url: string; ok: boolean; error?: string }>;
  /** Admin/storefront base and path templates for links in the UI */
  urls(): Promise<{ admin: string; storefront: string; paths: PlatformPaths }>;
  /** Read client + lookup for a session or the shop check (chat = name in the access log) */
  openSession(chat: string): PlatformSessionParts;
  /** ShopLookup via a (protected) read client of this platform, e.g. that of the shop check run */
  lookup(reader: unknown): ShopLookup;
  /** Tool names and tools of the platform (without core and feature tools) */
  toolNames: string[];
  tools(session: Session): AnyTool[];
  /** additional feature modules of this platform (outside features/index.ts); modules registered there choose their platform via Feature.platforms */
  features?: Feature[];
  /** loads the modules that register shop checks (registerCheck with platforms) */
  loadChecks(): Promise<void>;
  /** Active products in neutral form (name, texts, meta, price, stock, image) for custom checks; reads via the run's protected read client */
  scanProducts(reader: unknown): Promise<NeutralScan>;
  /** Write an approved change set (privileged client, only here) */
  apply(cs: ChangeSet, payload: unknown, selected: Set<string>, ctx?: ApplyCtx): Promise<ApplyResult>;
  /** Undo: run this platform's UndoOps in reverse order */
  undo(ops: UndoOp[]): Promise<{ ok: boolean; error?: string }[]>;
  pages: PlatformPages;
  context: PlatformContext;
  /** Storefront for the preview proxy /shop (base URL + fetch via the internal address) */
  storefront: { base(): Promise<string>; fetch: Fetcher };
}

export type { ShopCheck };

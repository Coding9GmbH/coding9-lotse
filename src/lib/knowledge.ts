// Knowledge base: shared types for server and UI.
import { DEFAULT_LOCALE, messages, type Locale } from './i18n';

/** upload = uploaded on the knowledge base page, chat = chat attachment, text = dictated by the user */
export type KnowledgeSource = 'upload' | 'chat' | 'text';
export interface KnowledgeLink { kind: 'product' | 'category'; id: string; number?: string | null; name?: string | null }
export interface KnowledgeDoc {
  id: string; title: string; source: KnowledgeSource; fileId?: string | null; fileName?: string | null; mime?: string | null;
  size: number; pages?: number | null; chars: number; chunks: number; tags: string[]; links: KnowledgeLink[]; createdAt: string; updatedAt: string;
}

export type RuleScope = 'all' | 'products' | 'pages' | 'seo';
/** Scope names in German (server, AI); per language: ruleScopeLabel(scope, locale) */
export const RULE_SCOPES: Record<RuleScope, string> = messages(DEFAULT_LOCALE).lib.knowledge.scopes;
export const ruleScopeLabel = (scope: RuleScope, locale: Locale = DEFAULT_LOCALE): string => messages(locale).lib.knowledge.scopes[scope];
/** Optional limit of a rule to one category (it then applies to this category and its products/pages) */
export interface RuleTarget { id: string; name: string }
export interface KnowledgeRule { id: string; text: string; scope: RuleScope; target: RuleTarget | null; createdAt: string; updatedAt: string }

export const RULE_MAX = 300;
/** Lead text of the knowledge base page: stored locally, excerpts and rules go to the model provider. */
export const KNOWLEDGE_LEAD = messages(DEFAULT_LOCALE).lib.knowledge.lead;
export const knowledgeLead = (locale: Locale = DEFAULT_LOCALE): string => messages(locale).lib.knowledge.lead;
export const TITLE_MAX = 160;

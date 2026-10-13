// Wissensbasis: gemeinsame Typen für Server und Oberfläche.
import { DEFAULT_LOCALE, messages, type Locale } from './i18n';

/** upload = auf der Seite Wissen hochgeladen, chat = Chat-Anhang, text = vom Nutzer diktiert */
export type KnowledgeSource = 'upload' | 'chat' | 'text';
export interface KnowledgeLink { kind: 'product' | 'category'; id: string; number?: string | null; name?: string | null }
export interface KnowledgeDoc {
  id: string; title: string; source: KnowledgeSource; fileId?: string | null; fileName?: string | null; mime?: string | null;
  size: number; pages?: number | null; chars: number; chunks: number; tags: string[]; links: KnowledgeLink[]; createdAt: string; updatedAt: string;
}

export type RuleScope = 'all' | 'products' | 'pages' | 'seo';
/** Bereichsnamen deutsch (Server, KI); je Sprache: ruleScopeLabel(scope, locale) */
export const RULE_SCOPES: Record<RuleScope, string> = messages(DEFAULT_LOCALE).lib.knowledge.scopes;
export const ruleScopeLabel = (scope: RuleScope, locale: Locale = DEFAULT_LOCALE): string => messages(locale).lib.knowledge.scopes[scope];
/** Optionale Begrenzung einer Regel auf eine Kategorie (gilt dann für diese Kategorie und deren Produkte/Seiten) */
export interface RuleTarget { id: string; name: string }
export interface KnowledgeRule { id: string; text: string; scope: RuleScope; target: RuleTarget | null; createdAt: string; updatedAt: string }

export const RULE_MAX = 300;
/** Lead der Wissensseite: lokal gespeichert, Auszüge und Regeln gehen an den Modellanbieter. */
export const KNOWLEDGE_LEAD = messages(DEFAULT_LOCALE).lib.knowledge.lead;
export const knowledgeLead = (locale: Locale = DEFAULT_LOCALE): string => messages(locale).lib.knowledge.lead;
export const TITLE_MAX = 160;

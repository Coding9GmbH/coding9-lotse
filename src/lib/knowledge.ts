// Wissensbasis: gemeinsame Typen für Server und Oberfläche.

/** upload = auf der Seite Wissen hochgeladen, chat = Chat-Anhang, text = vom Nutzer diktiert */
export type KnowledgeSource = 'upload' | 'chat' | 'text';
export interface KnowledgeLink { kind: 'product' | 'category'; id: string; number?: string | null; name?: string | null }
export interface KnowledgeDoc {
  id: string; title: string; source: KnowledgeSource; fileId?: string | null; fileName?: string | null; mime?: string | null;
  size: number; pages?: number | null; chars: number; chunks: number; tags: string[]; links: KnowledgeLink[]; createdAt: string; updatedAt: string;
}

export type RuleScope = 'all' | 'products' | 'pages' | 'seo';
export const RULE_SCOPES: Record<RuleScope, string> = { all: 'Überall', products: 'Produkttexte', pages: 'Seiten', seo: 'SEO' };
/** Optionale Begrenzung einer Regel auf eine Kategorie (gilt dann für diese Kategorie und deren Produkte/Seiten) */
export interface RuleTarget { id: string; name: string }
export interface KnowledgeRule { id: string; text: string; scope: RuleScope; target: RuleTarget | null; createdAt: string; updatedAt: string }

export const RULE_MAX = 300;
/** Lead der Wissensseite: lokal gespeichert, Auszüge und Regeln gehen an den Modellanbieter. */
export const KNOWLEDGE_LEAD = 'Datenblätter und PDFs als Faktenquelle. Lotse speichert sie lokal und nutzt sie für Produkttexte, FAQ und Sicherheitsinformationen. Auszüge gehen an Anthropic oder OpenAI. Eigene Regeln pflegst du im Styleguide.';
export const TITLE_MAX = 160;

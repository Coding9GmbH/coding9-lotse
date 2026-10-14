import type { SeoItem } from '@/lib/protocol';

/** Gruppen des SEO-Bereichs (und der SEO-Karte auf der Arbeitsfläche) */
export type SeoGroup = 'tech' | 'keyword' | 'content' | 'check';
export const seoGroup = (i: SeoItem): SeoGroup => (i.kind === 'onpage' ? 'tech' : i.kind === 'keyword' ? 'keyword' : 'content');
/** Shop-Check-Bereiche, die der SEO-Bereich mit anzeigt (Sistrix/Search Console kommen dort ausführlicher direkt aus der Quelle) */
export const SEO_CHECK_AREAS = new Set(['SEO', 'Links']);

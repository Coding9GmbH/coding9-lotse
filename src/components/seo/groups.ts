import type { SeoItem } from '@/lib/protocol';

/** Groups of the SEO section (and of the SEO card on the workspace) */
export type SeoGroup = 'tech' | 'ranking' | 'keyword' | 'content' | 'check';
export const seoGroup = (i: SeoItem): SeoGroup => (i.kind === 'onpage' || i.kind === 'site' ? 'tech' : i.kind === 'keyword' ? 'keyword' : i.kind === 'striking' || i.kind === 'cannibal' || i.kind === 'decline' ? 'ranking' : 'content');
/** Shop check sections that the SEO section also shows (Sistrix/Search Console appear there in more detail, straight from the source) */
export const SEO_CHECK_AREAS = new Set(['SEO', 'Links']);

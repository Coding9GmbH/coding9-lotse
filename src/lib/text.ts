// Text helpers without platform dependency.

/** URL slug/handle: lowercase, ä→ae ö→oe ü→ue ß→ss, accents removed, everything else to hyphens, truncated to max characters */
export const slugify = (s: unknown, max = 255) => String(s ?? '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');

const BLOCK_RE = new Map<string, RegExp>();
/**
 * Removes whole elements (default script/style) including their content. An unclosed tag swallows the rest of the
 * document: `(?:<\/x>|$)` keeps the scan linear (without it, many unclosed "<script" make the lazy match quadratic).
 */
export function stripBlocks(html: string, tags: readonly string[] = ['script', 'style'], by = ' '): string {
  const k = tags.join('|');
  let re = BLOCK_RE.get(k);
  if (!re) BLOCK_RE.set(k, (re = new RegExp(`<(${k})\\b[\\s\\S]*?(?:<\\/\\1\\s*>|$)`, 'gi')));
  return html.replace(re, by);
}

const ENT: Record<string, string> = { nbsp: ' ', amp: '&', quot: '"', lt: '<', gt: '>' };
/** Common HTML entities in ONE pass (so "&amp;lt;" stays "&lt;"); apostrophe entities become `apos`. */
export const decodeEntities = (s: string, apos = "'") => s.replace(/&(nbsp|amp|quot|lt|gt|apos|#0?39);/g, (_m, e: string) => ENT[e] ?? apos);

/** Visible text: drop `tags` blocks and all tags, &nbsp; (or with `decode` the common entities) → space, collapse whitespace. */
export function htmlToText(html: string, o: { tags?: readonly string[]; decode?: boolean; apos?: string } = {}): string {
  const t = stripBlocks(html, o.tags).replace(/<[^<>]+>/g, ' ');
  return (o.decode ? decodeEntities(t, o.apos) : t.replace(/&nbsp;/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Quoted attribute value of a tag (`name="…"` or `name='…'`), undefined if missing. */
export const attr = (tag: string, name: string): string | undefined => tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'))?.slice(1).find(v => v != null);

/**
 * For lazy `<x …>[\s\S]*?(?:<\/x>|$)` scans: the match if it really ends with </x>, else undefined. With `|$` an unclosed
 * tag swallows the rest instead of rescanning it from every later start (quadratic); without the close it was no match anyway.
 */
export const closed = (m: string | undefined, tag: string) => (m && m.slice(-tag.length - 3).toLowerCase() === `</${tag}>` ? m : undefined);
/** <h1>–<h4> with level (1) and content (2). The content may not contain another heading tag: linear even for unclosed headings. */
export const HEADINGS = /<h([1-4])[^<>]*>((?:(?!<\/?h[1-6]\b)[\s\S])*?)<\/h\1>/gi;

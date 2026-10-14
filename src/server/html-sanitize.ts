// Allowlist HTML sanitizer for imported rich text (e.g. supplier product descriptions).
// Hand-written single-pass scanner (linear time, no backtracking regex): keeps only formatting tags and safe attributes,
// re-serializes every kept tag from scratch, escapes stray < and >.

const TAGS = new Set(['p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'sub', 'sup', 'small', 'mark', 'del', 'ins', 'abbr', 'cite', 'q', 'code', 'pre',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'span', 'div', 'blockquote', 'hr', 'img', 'figure', 'figcaption',
  'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td']);
const VOID = new Set(['br', 'hr', 'img']);
/** Tags dropped together with their content */
const DROP = new Set(['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'template', 'noscript', 'noembed', 'noframes', 'svg', 'math', 'textarea', 'title', 'xmp', 'select', 'option']);
const GLOBAL = new Set(['title', 'class', 'lang', 'dir']);
const ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'name', 'target', 'rel']), img: new Set(['src', 'alt', 'width', 'height']),
  td: new Set(['colspan', 'rowspan']), th: new Set(['colspan', 'rowspan', 'scope']), ol: new Set(['start', 'type']),
};
const URL_ATTRS = new Set(['href', 'src']);

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', tab: '\t', newline: '\n', nbsp: ' ' };
/** Resolve HTML entities (&#106; &#x6A; &colon; …) as the browser does in attribute values */
export const decodeEntities = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, e: string) => {
  if (e[0] === '#') { const x = e[1].toLowerCase() === 'x', n = parseInt(e.slice(x ? 2 : 1), x ? 16 : 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
  return ENTITY[e.toLowerCase()] ?? m;
});
/** Link target allowed? No scheme (relative, anchor) or only http(s), mailto, tel; browsers ignore control characters and whitespace in the scheme */
export const safeUrl = (v: string) => { const m = /^([a-z][a-z0-9+.-]*):/i.exec(decodeEntities(v).replace(/[\u0000- \u007f-\u009f]/g, '')); return !m || /^(https?|mailto|tel)$/i.test(m[1]); };
const escText = (s: string) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
const encAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const isAlpha = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

interface Tag { name: string; close: boolean; attrs: [string, string][]; end: number }
/** Parses a tag starting at `<` (i); null if the input ends inside the tag. */
function parseTag(s: string, i: number): Tag | null {
  let j = i + 1; const close = s[j] === '/'; if (close) j++;
  const n0 = j; while (j < s.length && !isSpace(s[j]) && s[j] !== '/' && s[j] !== '>') j++;
  const name = s.slice(n0, j).toLowerCase(), attrs: [string, string][] = [];
  while (j < s.length) {
    const c = s[j];
    if (c === '>') return { name, close, attrs, end: j + 1 };
    if (isSpace(c) || c === '/') { j++; continue; }
    const a0 = j; j++; while (j < s.length && !isSpace(s[j]) && s[j] !== '/' && s[j] !== '>' && s[j] !== '=') j++;
    const an = s.slice(a0, j).toLowerCase(); let k = j; while (k < s.length && isSpace(s[k])) k++;
    if (s[k] !== '=') { attrs.push([an, '']); continue; }
    k++; while (k < s.length && isSpace(s[k])) k++;
    if (s[k] === '"' || s[k] === "'") { const e = s.indexOf(s[k], k + 1); if (e < 0) return null; attrs.push([an, s.slice(k + 1, e)]); j = e + 1; } else {
      const v0 = k; while (k < s.length && !isSpace(s[k]) && s[k] !== '>') k++; attrs.push([an, s.slice(v0, k)]); j = k;
    }
  }
  return null;
}

/** Allowlist sanitizer: formatting tags only, safe attributes only, link/image targets only http(s), mailto, tel or relative. */
export function sanitizeHtml(html: string): string {
  const s = html, low = s.toLowerCase(), out: string[] = [];
  let i = 0, text = 0;
  const flush = (to: number) => { if (to > text) out.push(escText(s.slice(text, to))); };
  while (i < s.length) {
    const lt = s.indexOf('<', i); if (lt < 0) break;
    const c = s.charCodeAt(lt + 1), slash = c === 47, startsTag = isAlpha(c) || (slash && isAlpha(s.charCodeAt(lt + 2)));
    if (s.startsWith('<!--', lt)) { // comment
      flush(lt); const e = s.indexOf('-->', lt + 4); i = text = e < 0 ? s.length : e + 3; continue;
    }
    if (s[lt + 1] === '!' || s[lt + 1] === '?' || (slash && !startsTag && s[lt + 2] !== undefined && s[lt + 2] !== '>' && !isSpace(s[lt + 2]))) { // doctype, PI, bogus comment
      flush(lt); const e = s.indexOf('>', lt + 1); i = text = e < 0 ? s.length : e + 1; continue;
    }
    if (!startsTag) { i = lt + 1; continue; } // stray "<": escaped as text
    const t = parseTag(s, lt);
    if (!t) { flush(lt); i = text = s.length; break; } // unterminated tag at the end: dropped like the browser does
    flush(lt); i = text = t.end;
    if (DROP.has(t.name)) { // drop tag and content up to the matching end tag
      if (!t.close) { const e = low.indexOf(`</${t.name}`, i); if (e < 0) { i = text = s.length; break; } const g = s.indexOf('>', e); i = text = g < 0 ? s.length : g + 1; }
      continue;
    }
    if (!TAGS.has(t.name)) continue;
    if (t.close) { if (!VOID.has(t.name)) out.push(`</${t.name}>`); continue; }
    const allowed = ATTRS[t.name], seen = new Set<string>();
    let tag = `<${t.name}`;
    for (const [n, v] of t.attrs) {
      if (seen.has(n) || !(GLOBAL.has(n) || allowed?.has(n))) continue;
      seen.add(n);
      const val = URL_ATTRS.has(n) && !safeUrl(v) ? '#' : decodeEntities(v);
      tag += ` ${n}="${encAttr(val)}"`;
    }
    out.push(tag + '>');
  }
  flush(s.length);
  return out.join('');
}

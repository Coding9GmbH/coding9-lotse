// Multilingual support, pure logic without shop access: split the texts of a slot config into translatable segments,
// reinsert translations (markup, CSS, JS stay untouched) and rewrite shop links to the target language.

const INLINE = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'i', 'ins', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr']);
const VOID = new Set(['br', 'wbr', 'img', 'input', 'hr', 'meta', 'link', 'source', 'area', 'base', 'col', 'embed', 'param', 'track']);
const RAW = new Set(['script', 'style', 'textarea', 'template']);
const ATTRS = ['alt', 'title', 'aria-label', 'placeholder'];
/** Config keys with plain text (e.g. slider titles, plugin elements) */
const TEXT_KEYS = new Set(['title', 'label', 'text', 'headline', 'subline', 'subtitle', 'buttonText', 'buttonLabel', 'alt', 'placeholder', 'confirmationText', 'description', 'content']);
const hasLetter = (s: string) => /\p{L}/u.test(s);

type Tok = { t: 'text' | 'other'; s: string } | { t: 'tag'; s: string; name: string; close: boolean; self: boolean } | { t: 'raw'; s: string; ld: boolean };

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', euro: '€', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', bdquo: '„', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', sbquo: '‚', copy: '©', reg: '®', trade: '™', times: '×', deg: '°', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç' };
// numeric entity → character; invalid code points (> U+10FFFF, e.g. typos from imports) stay literal instead of throwing
const codePoint = (e: string) => { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : null; };
export const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => (e[0] === '#' ? codePoint(e) ?? m : ENT[e] ?? m));
const encAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Visible text of an HTML snippet (for comparison, preview and JSON-LD matching) */
export const plain = (html: string) => decode(html.replace(/<\/?([a-zA-Z][\w:-]*)[^>]*>|<[^>]*>/g, (_m, n?: string) => (n && INLINE.has(n.toLowerCase()) && n.toLowerCase() !== 'br' ? '' : ' '))).replace(/\s+/g, ' ').trim();

function tokenize(html: string): Tok[] {
  const out: Tok[] = [], re = /<!--[\s\S]*?-->|<![^>]*>|<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m.index > last) out.push({ t: 'text', s: html.slice(last, m.index) });
    last = re.lastIndex;
    if (!m[2]) { out.push({ t: 'other', s: m[0] }); continue; }
    const name = m[2].toLowerCase(), close = !!m[1], self = /\/\s*$/.test(m[3]) || VOID.has(name);
    out.push({ t: 'tag', s: m[0], name, close, self });
    if (!close && !self && RAW.has(name)) { // take script/style content verbatim
      const end = html.slice(last).search(new RegExp(`</${name}\\s*>`, 'i')), stop = end < 0 ? html.length : last + end;
      out.push({ t: 'raw', s: html.slice(last, stop), ld: name === 'script' && /type\s*=\s*["']?application\/ld\+json/i.test(m[3]) });
      last = re.lastIndex = stop;
    }
  }
  if (last < html.length) out.push({ t: 'text', s: html.slice(last) });
  return out;
}

export interface Seg { kind: 'text' | 'attr' | 'value'; attr?: string; src: string }
export type Part = string | { seg: number } | { ld: string };
export interface Segmented { parts: Part[]; segs: Seg[] }

/** Splits HTML into fixed parts and translatable segments: text runs (incl. inline tags like <strong>, <a>) plus alt/title/aria-label/placeholder. */
export function segmentHtml(html: string): Segmented {
  const parts: Part[] = [], segs: Seg[] = [];
  const lit = (s: string) => { if (!s) return; if (typeof parts.at(-1) === 'string') parts[parts.length - 1] += s; else parts.push(s); };
  const seg = (sg: Seg) => { segs.push(sg); parts.push({ seg: segs.length - 1 }); };
  const tag = (tk: Tok) => {
    const isInput = tk.t === 'tag' && tk.name === 'input' && /\stype\s*=\s*["']?(submit|button|reset)/i.test(tk.s);
    const names = isInput ? [...ATTRS, 'value'] : ATTRS;
    const re = new RegExp(`(\\s(?:${names.join('|')})\\s*=\\s*)("([^"]*)"|'([^']*)')`, 'gi');
    let last = 0, m: RegExpExecArray | null;
    while ((m = re.exec(tk.s))) {
      const v = m[3] ?? m[4] ?? '';
      if (!hasLetter(decode(v))) continue;
      lit(tk.s.slice(last, m.index) + m[1] + '"'); seg({ kind: 'attr', attr: m[1].trim().replace(/\s*=\s*$/, '').toLowerCase(), src: decode(v) }); lit('"');
      last = m.index + m[0].length;
    }
    lit(tk.s.slice(last));
  };
  const emit = (tk: Tok) => (tk.t === 'tag' ? tag(tk) : lit(tk.s));
  let run: Tok[] = [];
  const lettered = (tk: Tok) => tk.t === 'text' && hasLetter(decode(tk.s));
  const textSeg = (toks: Tok[]) => { // leading/trailing whitespace stays outside the segment
    const src = toks.map(t => t.s).join(''), lead = src.match(/^\s*/)![0], trail = src.slice(lead.length).match(/\s*$/)![0];
    lit(lead); seg({ kind: 'text', src: src.slice(lead.length, src.length - trail.length) }); lit(trail);
  };
  // Partner (opening ↔ closing) of each inline tag within a run
  const partners = (r: Tok[]) => {
    const p = new Map<number, number>(), stack: number[] = [];
    r.forEach((t, i) => { if (t.t !== 'tag' || t.self) return; if (!t.close) stack.push(i); else { const j = stack.findLastIndex(k => (r[k] as { name: string }).name === t.name); if (j >= 0) { p.set(stack[j], i); p.set(i, stack[j]); stack.splice(j); } } });
    return p;
  };
  const flush = () => {
    const r = run; run = [];
    const idx = r.map((t, i) => (lettered(t) ? i : -1)).filter(i => i >= 0);
    if (!idx.length) { r.forEach(emit); return; }
    // smallest balanced range around the text: tags whose partner lies outside extend the range (e.g. <b>…</b>)
    const p = partners(r); let lo = idx[0], hi = idx[idx.length - 1], okSpan = true;
    const textAt = (i: number) => r[i]?.t === 'text';
    for (let changed = true; changed;) {
      changed = false;
      for (let i = lo; i <= hi; i++) {
        const t = r[i]; if (t.t !== 'tag' || t.self) continue;
        const q = p.get(i); if (q === undefined) { okSpan = false; break; }
        if (q < lo) { lo = q; changed = true; } else if (q > hi) { hi = q; changed = true; }
      }
      if (!okSpan) break;
    }
    // adjacent punctuation (e.g. "</a>.") belongs to the segment
    if (okSpan) { if (textAt(hi + 1)) hi++; if (textAt(lo - 1)) lo--; }
    if (!okSpan) { // unbalanced (e.g. tag spanning a block element): each text node separately
      r.forEach(t => (lettered(t) ? textSeg([t]) : emit(t)));
      return;
    }
    r.slice(0, lo).forEach(emit); textSeg(r.slice(lo, hi + 1)); r.slice(hi + 1).forEach(emit);
  };
  for (const tk of tokenize(html)) {
    if (tk.t === 'text' || (tk.t === 'tag' && INLINE.has(tk.name))) { run.push(tk); continue; }
    flush();
    if (tk.t === 'raw') { if (tk.ld) parts.push({ ld: tk.s }); else lit(tk.s); } else emit(tk);
  }
  flush();
  return { parts, segs };
}

const tagSig = (html: string) => [...html.matchAll(/<(\/?)([a-zA-Z][\w:-]*)/g)].map(m => (m[1] + m[2]).toLowerCase()).sort().join(',');
// Attributes of inline tags (except translatable ones like title/alt): href, class, style … must stay the same
const attrSig = (html: string) => [...html.matchAll(/<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)].map(m => m[1].toLowerCase() + [...m[2].matchAll(/([^\s=/]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g)]
  .map(a => { const n = a[1].toLowerCase(); return ATTRS.includes(n) ? ` ${n}` : ` ${n}=${decode((a[2] ?? '').replace(/^["']|["']$/g, ''))}`; }).sort().join('')).sort().join('|');
/** Checks a translation against the source segment: same inline tags, no block/script tags, not empty. */
export function checkSeg(sg: Seg, tr: string): string | null {
  if (typeof tr !== 'string' || !tr.trim()) return 'leer';
  if (sg.kind !== 'text') return /<[a-z/!]/i.test(tr) ? 'kein HTML erlaubt (reiner Text)' : null;
  const bad = [...tr.matchAll(/<\/?([a-zA-Z][\w:-]*)/g)].map(m => m[1].toLowerCase()).find(n => !INLINE.has(n));
  if (bad) return `Tag <${bad}> nicht erlaubt (nur Inline-Tags wie im Original)`;
  if (tagSig(sg.src) !== tagSig(tr)) return `Inline-Tags müssen wie im Original bleiben (${tagSig(sg.src) || 'keine'})`;
  if (/\son[a-z]+\s*=|javascript:/i.test(tr) && !/\son[a-z]+\s*=|javascript:/i.test(sg.src)) return 'Event-Handler/javascript: nicht erlaubt';
  if (attrSig(sg.src) !== attrSig(tr)) return 'Attribute der Inline-Tags (href, class, style …) müssen wie im Original bleiben; nur title/alt dürfen übersetzt werden';
  return null;
}

/** Inserts translations (missing → source text). JSON-LD (e.g. FAQ schema) is translated along via the visible text. */
export function rebuild({ parts, segs }: Segmented, tr: (i: number) => string | undefined): string {
  const map = new Map<string, string>();
  segs.forEach((s, i) => { const t = tr(i); if (t != null && s.kind === 'text') map.set(plain(s.src), plain(t)); else if (t != null) map.set(s.src.trim(), t.trim()); });
  const ld = (json: string) => {
    try {
      const walk = (x: unknown): unknown => typeof x === 'string' ? map.get(x.replace(/\s+/g, ' ').trim()) ?? x : Array.isArray(x) ? x.map(walk) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v)])) : x;
      return JSON.stringify(walk(JSON.parse(json))).replace(/</g, '\\u003c');
    } catch { return json; }
  };
  const one = (i: number) => { const s = segs[i], t = tr(i) ?? s.src; return s.kind === 'attr' ? encAttr(t) : t; };
  return parts.map(p => (typeof p === 'string' ? p : 'ld' in p ? ld(p.ld) : one(p.seg))).join('');
}

// ---- Slot config: all translatable texts of an element ----
export type Cfg = Record<string, { source?: string; value?: unknown } | null | undefined>;
export interface SlotSeg extends Seg { key: string; configKey: string }
const looksHtml = (s: string) => /<[a-z][^>]*>/i.test(s);

/** Translatable segments of a slot config (static values only), keys "{prefix}.{n}" in stable order. */
export function slotTexts(config: Cfg | null | undefined, prefix: string): { segs: SlotSeg[]; apply: (tr: Record<string, string>) => Cfg } {
  const cfg = config ?? {}, segs: SlotSeg[] = [], plans: { key: string; html?: Segmented; base: number }[] = [];
  for (const k of Object.keys(cfg).sort()) {
    const c = cfg[k]; if (!c || c.source === 'mapped' || typeof c.value !== 'string' || !hasLetter(c.value)) continue;
    if (looksHtml(c.value)) {
      const h = segmentHtml(c.value); plans.push({ key: k, html: h, base: segs.length });
      h.segs.forEach(s => segs.push({ ...s, key: `${prefix}.${segs.length}`, configKey: k }));
    } else if (TEXT_KEYS.has(k)) { plans.push({ key: k, base: segs.length }); segs.push({ kind: 'value', src: c.value, key: `${prefix}.${segs.length}`, configKey: k }); }
  }
  const apply = (tr: Record<string, string>): Cfg => {
    const out: Cfg = JSON.parse(JSON.stringify(cfg));
    for (const p of plans) {
      const c = out[p.key]!;
      c.value = p.html ? rebuild(p.html, i => tr[segs[p.base + i].key]) : tr[segs[p.base].key] ?? c.value;
    }
    return out;
  };
  return { segs, apply };
}

// ---- Rewrite links to the target language ----
export interface Domain { url: string; languageId: string; salesChannelId: string }
export interface SeoHit { routeName: string; foreignKey: string; salesChannelId: string; seoPathInfo: string; languageId: string }
export interface LinkIndex { domains: Domain[]; targetLanguageId: string; targetLanguageName: string; bySeoPath: Map<string, SeoHit>; targetSeo: Map<string, string> }
const ROUTES: [RegExp, string, string][] = [[/^navigation\/([0-9a-f]{32})$/, 'frontend.navigation.page', 'navigation'], [/^detail\/([0-9a-f]{32})$/, 'frontend.detail.page', 'detail'], [/^landingPage\/([0-9a-f]{32})$/, 'frontend.landing.page', 'landingPage']];
const trimSlash = (s: string) => s.replace(/^\/+|\/+$/g, '');
export const seoKey = (sc: string, route: string, fk: string) => `${sc}|${route}|${fk}`;

/** Splits a shop URL into sales channel + path (null = external, anchor, mailto …). */
export function shopPath(url: string, domains: Domain[]): { sc?: string; path: string; tail: string } | null {
  const u = url.trim(); let rest: string | null = null, sc: string | undefined;
  if (/^\/(?!\/)/.test(u)) rest = u;
  else {
    const d = [...domains].sort((a, b) => b.url.length - a.url.length).find(x => u === x.url || u.startsWith(x.url.replace(/\/$/, '') + '/'));
    if (d) { rest = u.slice(d.url.replace(/\/$/, '').length) || '/'; sc = d.salesChannelId; }
  }
  if (rest == null) return null;
  const cut = rest.search(/[?#]/), path = cut < 0 ? rest : rest.slice(0, cut), tail = cut < 0 ? '' : rest.slice(cut);
  return { sc, path: trimSlash(path), tail };
}
/** Paths under which an SEO URL is looked up (with/without trailing slash) */
export const seoVariants = (path: string) => [path, path + '/'];

/** Shop link → same page in the target language (target language's SEO URL on its domain). note explains why a link stays. */
export function mapUrl(url: string, ix: LinkIndex): { url: string; note?: string } {
  const sp = shopPath(url, ix.domains);
  if (!sp || !sp.path) return { url };
  let route: string | undefined, fk: string | undefined, sc = sp.sc;
  for (const [re, r] of ROUTES) { const m = sp.path.match(re); if (m) { route = r; fk = m[1]; } }
  if (!route) {
    const hit = seoVariants(sp.path).map(p => ix.bySeoPath.get(p)).find(h => h && (!sc || h.salesChannelId === sc));
    if (!hit) return { url, note: `Link ${url}: keine Shop-Seite zugeordnet, bleibt unverändert` };
    route = hit.routeName; fk = hit.foreignKey; sc = hit.salesChannelId;
  }
  const dom = ix.domains.find(d => d.languageId === ix.targetLanguageId && (!sc || d.salesChannelId === sc));
  if (!dom) return { url, note: `Link ${url}: keine Domain für ${ix.targetLanguageName}, bleibt unverändert` };
  const seo = ix.targetSeo.get(seoKey(dom.salesChannelId, route, fk!));
  const tech = ROUTES.find(r => r[1] === route)![2];
  const out = `${dom.url.replace(/\/$/, '')}/${seo ? trimSlash(seo) + (seo.endsWith('/') ? '/' : '') : `${tech}/${fk}`}${sp.tail}`;
  return out === url ? { url } : { url: out, ...(seo ? {} : { note: `Link ${url}: keine SEO-URL in ${ix.targetLanguageName}, technischer Pfad` }) };
}

/** All link targets of a config (href in HTML values, url values) */
export function configLinks(config: Cfg | null | undefined): string[] {
  const out: string[] = [];
  for (const [k, c] of Object.entries(config ?? {})) {
    if (!c || c.source === 'mapped') continue;
    if (Array.isArray(c.value)) { for (const x of c.value) if (typeof x?.url === 'string' && x.url) out.push(x.url); continue; } // e.g. sliderItems[].url
    if (typeof c.value !== 'string') continue;
    if (k === 'url' && c.value) out.push(c.value);
    else for (const m of c.value.matchAll(/\shref\s*=\s*(["'])(.*?)\1/gi)) out.push(decode(m[2]));
  }
  return out;
}

/** Rewrites all links of a config; returns the new config and notes. */
export function mapConfigLinks(config: Cfg, ix: LinkIndex): { config: Cfg; changed: { from: string; to: string }[]; notes: string[] } {
  const out: Cfg = JSON.parse(JSON.stringify(config)), changed: { from: string; to: string }[] = [], notes = new Set<string>();
  const map = (u: string) => { const r = mapUrl(u, ix); if (r.note) notes.add(r.note); if (r.url !== u) changed.push({ from: u, to: r.url }); return r.url; };
  for (const [k, c] of Object.entries(out)) {
    if (!c || c.source === 'mapped') continue;
    if (Array.isArray(c.value)) { for (const x of c.value) if (typeof x?.url === 'string' && x.url) x.url = map(x.url); continue; }
    if (typeof c.value !== 'string') continue;
    if (k === 'url' && c.value) c.value = map(c.value);
    else c.value = c.value.replace(/(\shref\s*=\s*)(["'])(.*?)\2/gi, (m, pre: string, q: string, v: string) => { const d = decode(v), n = map(d); return n === d ? m : `${pre}${q}${encAttr(n)}${q}`; });
  }
  return { config: out, changed, notes: [...notes] };
}

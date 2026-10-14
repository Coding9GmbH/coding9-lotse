// Detects active content (JavaScript) in proposed changes, for the approval card and the quality check.
// Background: custom-html blocks and HTML fields may contain JS. An AI manipulated via prompt injection could thus
// propose e.g. a card skimmer that is invisible in the visual preview. The human should see this BEFORE "Anwenden" (apply).

/** script: <script>, handler: on…=, url: javascript:, js: js field of a custom-html block, embed: iframe/object/embed/form to a foreign address */
export type ScriptKind = 'script' | 'handler' | 'url' | 'js' | 'embed';
export interface ScriptRisk { kinds: ScriptKind[]; hosts: string[] }

// Decode entities (&#106;avascript:, &colon; …) so encoded variants don't slip through
const decode = (s: string) => s.replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16) || 32)).replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(+d || 32)).replace(/&colon;/gi, ':').replace(/&tab;|&newline;/gi, '');
const hostOf = (u: string) => { try { return new URL(u.startsWith('//') ? `https:${u}` : u).hostname.toLowerCase(); } catch { return null; } };
const ABS = /(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?/gi;
// Addresses the browser itself loads from or sends to (links <a href> are normal and don't count)
const LOADS = /\b(?:src|srcset|action|formaction|data|poster|background)\s*=\s*["']?\s*((?:https?:)?\/\/[^\s"'>]+)|<link\b[^>]*\bhref\s*=\s*["']?((?:https?:)?\/\/[^\s"'>]+)|url\(\s*["']?((?:https?:)?\/\/[^\s"')]+)|@import\s+["']((?:https?:)?\/\/[^"']+)/gi;
const EMBED = /<(?:iframe|object|embed|frame)\b[^>]*\b(?:src|data)\s*=\s*["']?\s*(?:https?:)?\/\/|<form\b[^>]*\baction\s*=\s*["']?\s*(?:https?:)?\/\//i;

function scanString(s: string, kinds: Set<ScriptKind>, hosts: Set<string>) {
  if (!/[<:]|\/\//.test(s)) return;
  const d = decode(s), code: string[] = [];
  for (const m of d.matchAll(/<script\b([^>]*)>([\s\S]*?)(?:<\/script\s*>|$)/gi)) {
    const type = m[1].match(/\btype\s*=\s*["']?([^"'\s>]+)/i)?.[1].toLowerCase();
    if (type && !/javascript|ecmascript|^module$/.test(type)) continue; // data blocks (JSON-LD for FAQ schema) don't execute
    kinds.add('script'); code.push(m[2]); // src= is captured by LOADS
  }
  for (const m of d.matchAll(/<[a-z][^>]*?[\s/"']on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi)) { kinds.add('handler'); code.push(m[1]); }
  if (/j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:/i.test(d)) kinds.add('url');
  if (EMBED.test(d)) kinds.add('embed');
  for (const m of d.matchAll(LOADS)) { const h = hostOf(m[1] ?? m[2] ?? m[3] ?? m[4]); if (h) hosts.add(h); }
  // Addresses in the script itself (fetch/XMLHttpRequest/sendBeacon/new Image …: anything that looks like a host)
  for (const c of code) for (const m of c.matchAll(ABS)) { const h = hostOf(m[0]); if (h) hosts.add(h); }
}

/** Searches arbitrary values (spec, payload, change rows) for JavaScript; null = nothing found */
export function scriptRisk(...values: unknown[]): ScriptRisk | null {
  const kinds = new Set<ScriptKind>(), hosts = new Set<string>(), seen = new Set<unknown>();
  const walk = (v: unknown, key = '', depth = 0): void => {
    if (depth > 40 || v == null) return;
    if (typeof v === 'string') {
      if (key === 'js' && v.trim()) { kinds.add('js'); for (const m of v.matchAll(ABS)) { const h = hostOf(m[0]); if (h) hosts.add(h); } }
      scanString(v, kinds, hosts); return;
    }
    if (typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { for (const x of v) walk(x, key, depth + 1); return; }
    for (const [k, x] of Object.entries(v)) walk(x, k, depth + 1);
  };
  for (const v of values) walk(v);
  // foreign load addresses alone (images from a CDN) are no risk; only report together with script/embedding
  return kinds.size ? { kinds: [...kinds], hosts: [...hosts].sort() } : null;
}

/** Short German notice text (quality check, reply to the AI) */
export const scriptRiskText = (r: ScriptRisk) => `Wichtig: Diese Änderung enthält JavaScript (${r.kinds.join(', ')}). Es läuft später bei jedem Besucher im Shop.${r.hosts.length ? ` Lädt von bzw. sendet an: ${r.hosts.join(', ')}.` : ''} Vor der Freigabe prüfen, ob das Skript wirklich gewollt ist.`;
/** For change sets: { script } only if JS was found (otherwise the set stays unchanged) */
export const withScript = (...values: unknown[]): { script?: ScriptRisk } => { const r = scriptRisk(...values); return r ? { script: r } : {}; };

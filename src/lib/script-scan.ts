// Erkennt aktiven Inhalt (JavaScript) in vorgeschlagenen Änderungen – für die Freigabe-Karte und den Qualitäts-Check.
// Hintergrund: custom-html-Blöcke und HTML-Felder dürfen JS enthalten. Eine per Prompt-Injection manipulierte KI könnte so
// z. B. einen Kartendaten-Skimmer vorschlagen, der in der optischen Vorschau unsichtbar ist. Der Mensch soll das VOR „Anwenden“ sehen.

/** script: <script>, handler: on…=, url: javascript:, js: js-Feld eines custom-html-Blocks, embed: iframe/object/embed/Formular an fremde Adresse */
export type ScriptKind = 'script' | 'handler' | 'url' | 'js' | 'embed';
export interface ScriptRisk { kinds: ScriptKind[]; hosts: string[] }

// Entities auflösen (&#106;avascript:, &colon; …), damit kodierte Varianten nicht durchrutschen
const decode = (s: string) => s.replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16) || 32)).replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(+d || 32)).replace(/&colon;/gi, ':').replace(/&tab;|&newline;/gi, '');
const hostOf = (u: string) => { try { return new URL(u.startsWith('//') ? `https:${u}` : u).hostname.toLowerCase(); } catch { return null; } };
const ABS = /(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?/gi;
// Adressen, von denen der Browser selbst lädt bzw. an die er sendet (Links <a href> sind normal und zählen nicht)
const LOADS = /\b(?:src|srcset|action|formaction|data|poster|background)\s*=\s*["']?\s*((?:https?:)?\/\/[^\s"'>]+)|<link\b[^>]*\bhref\s*=\s*["']?((?:https?:)?\/\/[^\s"'>]+)|url\(\s*["']?((?:https?:)?\/\/[^\s"')]+)|@import\s+["']((?:https?:)?\/\/[^"']+)/gi;
const EMBED = /<(?:iframe|object|embed|frame)\b[^>]*\b(?:src|data)\s*=\s*["']?\s*(?:https?:)?\/\/|<form\b[^>]*\baction\s*=\s*["']?\s*(?:https?:)?\/\//i;

function scanString(s: string, kinds: Set<ScriptKind>, hosts: Set<string>) {
  if (!/[<:]|\/\//.test(s)) return;
  const d = decode(s), code: string[] = [];
  for (const m of d.matchAll(/<script\b([^>]*)>([\s\S]*?)(?:<\/script\s*>|$)/gi)) {
    const type = m[1].match(/\btype\s*=\s*["']?([^"'\s>]+)/i)?.[1].toLowerCase();
    if (type && !/javascript|ecmascript|^module$/.test(type)) continue; // Daten-Blöcke (JSON-LD für FAQ-Schema) laufen nicht
    kinds.add('script'); code.push(m[2]); // src= erfasst LOADS
  }
  for (const m of d.matchAll(/<[a-z][^>]*?[\s/"']on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi)) { kinds.add('handler'); code.push(m[1]); }
  if (/j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:/i.test(d)) kinds.add('url');
  if (EMBED.test(d)) kinds.add('embed');
  for (const m of d.matchAll(LOADS)) { const h = hostOf(m[1] ?? m[2] ?? m[3] ?? m[4]); if (h) hosts.add(h); }
  // Adressen im Skript selbst (fetch/XMLHttpRequest/sendBeacon/new Image … – alles, was nach Host aussieht)
  for (const c of code) for (const m of c.matchAll(ABS)) { const h = hostOf(m[0]); if (h) hosts.add(h); }
}

/** Durchsucht beliebige Werte (Spec, Payload, Änderungszeilen) nach JavaScript; null = nichts gefunden */
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
  // fremde Ladeadressen allein (Bilder vom CDN) sind kein Risiko – nur zusammen mit Skript/Einbettung melden
  return kinds.size ? { kinds: [...kinds], hosts: [...hosts].sort() } : null;
}

/** Kurzer deutscher Hinweistext (Qualitäts-Check, Antwort an die KI) */
export const scriptRiskText = (r: ScriptRisk) => `Wichtig: Diese Änderung enthält JavaScript (${r.kinds.join(', ')}). Es läuft später bei jedem Besucher im Shop.${r.hosts.length ? ` Lädt von bzw. sendet an: ${r.hosts.join(', ')}.` : ''} Vor der Freigabe prüfen, ob das Skript wirklich gewollt ist.`;
/** Für Änderungssets: { script } nur wenn JS gefunden (sonst bleibt das Set unverändert) */
export const withScript = (...values: unknown[]): { script?: ScriptRisk } => { const r = scriptRisk(...values); return r ? { script: r } : {}; };

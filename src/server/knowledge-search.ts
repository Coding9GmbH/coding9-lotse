// Wissensbasis-Suche ohne externe Dienste: BM25 über Abschnitte mit deutscher Normalisierung
// (Kleinschreibung, Umlaute, einfache Stammformen, Teilwort-Treffer für Komposita).

const STOP = new Set(('aber alle allem allen aller alles als also am an ander andere auch auf aus bei bin bis bist da damit dann das dass dem den der des die dies diese diesem diesen dieser doch dort du durch ein eine einem einen einer eines er es etwas für hat hatte hier ich ihr im in ist ja jede jedem jeden jeder kann kein keine mit muss nach nicht noch nur ob oder ohne sehr sein seine sich sie sind so über um und uns unter vom von vor war was wenn wer wie wir wird zu zum zur zwischen'
  + ' the and for with of to in on is are a an').split(' ').map(w => fold(w)));

/** Kleinschreibung + Umlaute/ß falten + Akzente entfernen. */
export function fold(s: string): string {
  return s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/\p{M}/gu, '');
}

/** Einfache deutsche Stammform: häufige Flexionsendungen abschneiden (Stamm bleibt ≥ 4 Zeichen). */
export function stem(w: string): string {
  if (w.length <= 4 || /\d/.test(w)) return w;
  for (const suf of ['ungen', 'heiten', 'keiten', 'ern', 'em', 'er', 'en', 'es', 'e', 'n', 's']) {
    if (w.endsWith(suf) && w.length - suf.length >= 4) return w.slice(0, -suf.length);
  }
  return w;
}

export function tokenize(s: string): string[] {
  return (fold(s).match(/[a-z0-9]+/g) ?? []).filter(t => t.length > 1 && !STOP.has(t)).map(stem);
}

export interface IndexDoc { key: string; text: string; boost?: number }
interface Posting { doc: number; tf: number }
export interface SearchIndex { docs: IndexDoc[]; len: number[]; avg: number; terms: Map<string, Posting[]> }

export function buildIndex(docs: IndexDoc[]): SearchIndex {
  const terms = new Map<string, Posting[]>(); const len: number[] = [];
  docs.forEach((d, i) => {
    const toks = tokenize(d.text); len.push(toks.length);
    const tf = new Map<string, number>(); for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [t, n] of tf) { let p = terms.get(t); if (!p) terms.set(t, p = []); p.push({ doc: i, tf: n }); }
  });
  return { docs, len, avg: len.reduce((a, b) => a + b, 0) / Math.max(1, len.length), terms };
}

/** Indexbegriffe zu einem Suchbegriff mit Gewicht: exakt 1, Wortanfang 0,7 (Vase → Vasenset), Wortende 0,5 (Vase → Bodenvase). */
function variants(idx: SearchIndex, q: string): [string, number][] {
  const out: [string, number][] = [];
  for (const t of idx.terms.keys()) {
    if (t === q) out.push([t, 1]);
    else if (q.length >= 4 && t.length > q.length) { if (t.startsWith(q)) out.push([t, 0.7]); else if (t.endsWith(q) || (q.endsWith('e') && (t + 'e').endsWith(q))) out.push([t, 0.5]); } // Stamm ohne End-e (Bodenvase → bodenvas)
    else if (t.length >= 4 && q.length > t.length && q.startsWith(t) && q.length - t.length <= 2) out.push([t, 0.8]); // Flexionsrest (Kiesel ↔ Kieseln)
  }
  return out;
}

export interface Hit { key: string; score: number }
const K1 = 1.2, B = 0.75;

/** BM25 mit Teilwort-Treffern; je Suchbegriff zählt die beste Variante. boost (z. B. Produktbezug) multipliziert. */
export function search(idx: SearchIndex, query: string, limit = 8, boost: (key: string) => number = () => 1): Hit[] {
  const q = [...new Set(tokenize(query))]; if (!q.length || !idx.docs.length) return [];
  const N = idx.docs.length, scores = new Map<number, number>();
  for (const qt of q) {
    const best = new Map<number, number>();
    for (const [t, w] of variants(idx, qt)) {
      const posts = idx.terms.get(t)!; const idf = Math.log(1 + (N - posts.length + 0.5) / (posts.length + 0.5));
      for (const { doc, tf } of posts) {
        const s = w * idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * idx.len[doc] / (idx.avg || 1)));
        if (s > (best.get(doc) ?? 0)) best.set(doc, s);
      }
    }
    for (const [d, s] of best) scores.set(d, (scores.get(d) ?? 0) + s);
  }
  return [...scores].map(([d, s]) => ({ key: idx.docs[d].key, score: s * (idx.docs[d].boost ?? 1) * boost(idx.docs[d].key) }))
    .sort((a, b) => b.score - a.score).slice(0, limit).map(h => ({ ...h, score: Math.round(h.score * 100) / 100 }));
}

/** Wörtliche Suche (Artikelnummer, EAN, Produktname) unabhängig von Groß-/Kleinschreibung und Umlauten. */
export const containsLoose = (text: string, needle: string) => {
  const n = fold(needle).replace(/\s+/g, ' ').trim();
  return n.length >= 3 && fold(text).replace(/\s+/g, ' ').includes(n);
};

import 'server-only';
// Parst unvollständiges JSON (Tool-Input während des Streamings) so weit wie möglich
export function parsePartial(src: string): unknown {
  let t = src;
  for (let i = 0; i < 60 && t.length; i++) {
    const closers: string[] = []; let inStr = false, esc = false;
    for (const ch of t) {
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true; else if (ch === '{') closers.push('}'); else if (ch === '[') closers.push(']'); else if (ch === '}' || ch === ']') closers.pop();
    }
    try { return JSON.parse(t + (inStr ? '"' : '') + closers.reverse().join('')); } catch {}
    const idx = Math.max(t.lastIndexOf(','), t.lastIndexOf('{'), t.lastIndexOf('['));
    if (idx < 0) return null;
    t = t[idx] === ',' ? t.slice(0, idx) : t.slice(0, idx + 1);
  }
  return null;
}

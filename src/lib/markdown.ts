import { esc } from './format';

// Minimales, sicheres Markdown wie in der bisherigen Oberfläche: **fett**, `code`, - Listen, Tabellen, Absätze.
// Jeder Text wird ZUERST maskiert; erst danach werden die wenigen erlaubten Tags erzeugt.
// Das Ergebnis enthält daher nur <p>, <br>, <b>, <code>, <ul>, <li>, <table>-Elemente und ein <div> als Scroll-Hülle.

const inline = (x: string): string =>
  esc(x)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

const isTableLine = (l: string) => /^\s*\|/.test(l);
const isSeparator = (l: string) => /^\s*\|?\s*:?-{2,}/.test(l);
const isListLine = (l: string) => /^\s*[-•]\s+/.test(l);

function table(lines: string[]): string {
  const rows = lines
    .filter(l => !isSeparator(l))
    .map(l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim())));
  const [head = [], ...body] = rows;
  return `<div class="md-scroll"><table class="mdt"><thead><tr>${head.map(c => `<th>${c}</th>`).join('')}</tr></thead>`
    + `<tbody>${body.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

export function markdown(text: string): string {
  return String(text ?? '')
    .split(/\n{2,}/)
    .map(block => {
      const lines = block.split('\n');
      if (lines.length > 1 && lines.every(isTableLine)) return table(lines);
      if (lines.every(isListLine)) return `<ul>${lines.map(l => `<li>${inline(l.replace(/^\s*[-•]\s+/, ''))}</li>`).join('')}</ul>`;
      return `<p>${lines.map(inline).join('<br>')}</p>`;
    })
    .join('');
}

import { esc } from './format';

// Minimal, safe Markdown as in the previous UI: **bold**, `code`, - lists, tables, paragraphs.
// All text is escaped FIRST; only then are the few allowed tags generated.
// The result therefore contains only <p>, <br>, <b>, <code>, <ul>, <li>, <table> elements and a <div> as scroll wrapper.

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

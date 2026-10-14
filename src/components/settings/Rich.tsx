// Minimal markup for translated texts: **bold**, `code`, [link text] (one link per text, target via href).
const TOKEN = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\])/g;

export function rich(text: string, link?: { href: string; text?: string }): React.ReactNode {
  return text.split(TOKEN).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <b key={i}>{part.slice(2, -2)}</b>;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={i}>{part.slice(1, -1)}</code>;
    if (link && part.startsWith('[') && part.endsWith(']')) return <a key={i} href={link.href} target="_blank" rel="noreferrer">{link.text ?? part.slice(1, -1)}</a>;
    return part;
  });
}

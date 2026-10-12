// Änderungswünsche, die direkt in der Vorschau an Elementen markiert werden, und die Nachricht an Lotse daraus.

export interface Annotation {
  id: string;
  /** Kurze Beschreibung des Elements, z. B. Button „Jetzt kaufen“ */
  label: string;
  /** Überschrift des Abschnitts, in dem das Element steht */
  section?: string;
  /** CSS-Pfad als Hilfe zum Wiederfinden (z. B. „section.hero > a.btn“) */
  path: string;
  /** Was anders sein soll – in den Worten des Nutzers */
  note: string;
}

/** Baut aus den gesammelten Wünschen eine eindeutige Nachricht an Lotse. */
export function annotationMessage(list: Annotation[], where: 'draft' | 'live'): string {
  const head = where === 'draft'
    ? 'Änderungswünsche zum Entwurf, direkt in der Vorschau markiert. Bitte alle Punkte einarbeiten, sonst nichts verändern, und den Entwurf neu erzeugen:'
    : 'Änderungswünsche zur aktuellen Seite im Shop, direkt in der Vorschau markiert. Bitte alle Punkte als Entwurf umsetzen, sonst nichts verändern:';
  const lines = list.map((a, i) =>
    `${i + 1}. ${a.label}${a.section ? ` (Abschnitt „${a.section}“)` : ''}: ${a.note.trim()}\n   Element: ${a.path}`);
  return `${head}\n${lines.join('\n')}`;
}

const KINDS: [RegExp, string][] = [
  [/^(button)$/, 'Button'], [/^a$/, 'Link'], [/^img$/, 'Bild'], [/^h[1-6]$/, 'Überschrift'],
  [/^(p|li|blockquote|figcaption|small|span|strong|em)$/, 'Text'], [/^(table|tr|td|th)$/, 'Tabelle'],
  [/^(details|summary)$/, 'FAQ-Eintrag'], [/^(section|article|header|footer)$/, 'Abschnitt'],
];

/** Lesbare Bezeichnung für ein Element: Art + sichtbarer Text bzw. Alt-Text. */
export function describeElement(tag: string, opts: { text?: string; alt?: string; isButton?: boolean }): string {
  const t = tag.toLowerCase();
  const kind = opts.isButton ? 'Button' : KINDS.find(([re]) => re.test(t))?.[1] ?? 'Element';
  const raw = (t === 'img' ? opts.alt : opts.text)?.replace(/\s+/g, ' ').trim() ?? '';
  const short = raw.length > 60 ? `${raw.slice(0, 57)}…` : raw;
  return short ? `${kind} „${short}“` : kind;
}

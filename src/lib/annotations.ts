// Change requests marked on elements directly in the preview, and the message to Lotse built from them.
import { DEFAULT_LOCALE, messages, type Locale, type Messages } from './i18n';

export interface Annotation {
  id: string;
  /** Short description of the element, e.g. button "Jetzt kaufen" */
  label: string;
  /** Heading of the section containing the element */
  section?: string;
  /** CSS path as a help to find it again (e.g. "section.hero > a.btn") */
  path: string;
  /** What should be different, in the user's words */
  note: string;
}

/** Builds an unambiguous message to Lotse from the collected requests. */
export function annotationMessage(list: Annotation[], where: 'draft' | 'live', locale: Locale = DEFAULT_LOCALE): string {
  const t = messages(locale).lib.annotations;
  const head = where === 'draft' ? t.headDraft : t.headLive;
  const lines = list.map((a, i) =>
    `${i + 1}. ${a.label}${a.section ? t.section(a.section) : ''}: ${a.note.trim()}\n   Element: ${a.path}`);
  return `${head}\n${lines.join('\n')}`;
}

type ElementKind = keyof Messages['lib']['annotations']['kinds'];
const KINDS: [RegExp, ElementKind][] = [
  [/^(button)$/, 'button'], [/^a$/, 'link'], [/^img$/, 'image'], [/^h[1-6]$/, 'heading'],
  [/^(p|li|blockquote|figcaption|small|span|strong|em)$/, 'text'], [/^(table|tr|td|th)$/, 'table'],
  [/^(details|summary)$/, 'faq'], [/^(section|article|header|footer)$/, 'section'],
];

/** Readable label for an element: kind + visible text or alt text. */
export function describeElement(tag: string, opts: { text?: string; alt?: string; isButton?: boolean }, locale: Locale = DEFAULT_LOCALE): string {
  const t = tag.toLowerCase(), m = messages(locale).lib.annotations;
  const kind = m.kinds[opts.isButton ? 'button' : KINDS.find(([re]) => re.test(t))?.[1] ?? 'element'];
  const raw = (t === 'img' ? opts.alt : opts.text)?.replace(/\s+/g, ' ').trim() ?? '';
  const short = raw.length > 60 ? `${raw.slice(0, 57)}…` : raw;
  return short ? m.quoted(kind, short) : kind;
}

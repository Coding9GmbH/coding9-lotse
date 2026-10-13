import { DEFAULT_LOCALE, messages, type Locale } from './i18n';
import type { TargetKind } from './protocol';

/** Anzeigenamen der KI-Werkzeuge (Arbeitsschritte im Chat), deutsch; je Sprache: toolLabel(name, locale). */
export const TOOL_LABELS: Record<string, string> = messages(DEFAULT_LOCALE).lib.tools;
export const toolLabel = (name: string, locale: Locale = DEFAULT_LOCALE): string => (messages(locale).lib.tools as Record<string, string>)[name] ?? name;

export const KIND_LABEL: Record<TargetKind, string> = messages(DEFAULT_LOCALE).lib.kind;
export const kindLabel = (kind: TargetKind, locale: Locale = DEFAULT_LOCALE): string => messages(locale).lib.kind[kind];

/** Kennung des Schlagworts (bleibt deutsch, steckt im CSS-Klassennamen); Anzeige über exampleTagLabel(). */
export type ExampleTag = 'Produkte' | 'Layout' | 'Preise' | 'Daten' | 'Inhalt' | 'SEO' | 'Analyse';
export interface Example { tag: ExampleTag; title: string; text: string }
export const exampleTagLabel = (tag: ExampleTag, locale: Locale = DEFAULT_LOCALE): string => messages(locale).lib.exampleTag[tag];

// KI-first: Produkte, Inhalte und SEO zuerst – Seiten und Layouts kommen obendrauf
const EXAMPLE_TAGS: ExampleTag[] = ['Produkte', 'Produkte', 'SEO', 'SEO', 'Preise', 'Inhalt', 'Daten', 'Layout', 'Layout'];
export const examples = (p: string, c: string, locale: Locale = DEFAULT_LOCALE): Example[] =>
  messages(locale).lib.examples(p, c).map((e, i) => ({ tag: EXAMPLE_TAGS[i], ...e }));

/** Vorschlags-Chips je Kontext (deutsch); je Sprache: suggestions(kind, locale). */
export const SUGGESTIONS: Record<TargetKind, string[]> = messages(DEFAULT_LOCALE).lib.suggestions;
export const suggestions = (kind: TargetKind, locale: Locale = DEFAULT_LOCALE): string[] => messages(locale).lib.suggestions[kind];

export const DEFAULT_PLACEHOLDER = messages(DEFAULT_LOCALE).lib.placeholder.default;
export const defaultPlaceholder = (locale: Locale = DEFAULT_LOCALE): string => messages(locale).lib.placeholder.default;
export const placeholderFor = (kind: TargetKind, name = '', locale: Locale = DEFAULT_LOCALE): string => {
  const t = messages(locale).lib.placeholder;
  return kind === 'landing' ? t.landing : t[kind](name);
};

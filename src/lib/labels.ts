import { DEFAULT_LOCALE, messages, type Locale } from './i18n';
import type { TargetKind } from './protocol';

/** Display names of the AI tools (work steps in the chat), German; per language: toolLabel(name, locale). */
export const TOOL_LABELS: Record<string, string> = messages(DEFAULT_LOCALE).lib.tools;
export const toolLabel = (name: string, locale: Locale = DEFAULT_LOCALE): string => (messages(locale).lib.tools as Record<string, string>)[name] ?? name;

export const KIND_LABEL: Record<TargetKind, string> = messages(DEFAULT_LOCALE).lib.kind;
export const kindLabel = (kind: TargetKind, locale: Locale = DEFAULT_LOCALE): string => messages(locale).lib.kind[kind];

/** Tag identifier (stays German, it is part of the CSS class name); displayed via exampleTagLabel(). */
export type ExampleTag = 'Produkte' | 'Layout' | 'Preise' | 'Daten' | 'Inhalt' | 'SEO' | 'Analyse';
export interface Example { tag: ExampleTag; title: string; text: string }
export const exampleTagLabel = (tag: ExampleTag, locale: Locale = DEFAULT_LOCALE): string => messages(locale).lib.exampleTag[tag];

// AI-first: products, content and SEO first; pages and layouts come on top
const EXAMPLE_TAGS: ExampleTag[] = ['Produkte', 'Produkte', 'SEO', 'SEO', 'Preise', 'Inhalt', 'Daten', 'Layout', 'Layout', 'Analyse', 'SEO', 'Daten'];
/** Examples that need an integration (same order as EXAMPLE_TAGS): only shown when it is connected */
export type ExampleNeeds = 'gsc' | 'sistrix' | 'shopware';
const EXAMPLE_NEEDS: (ExampleNeeds | undefined)[] = [undefined, undefined, undefined, 'gsc', undefined, undefined, undefined, undefined, undefined, 'sistrix', 'sistrix', 'shopware'];
export type ExampleAvailability = { gsc?: boolean; sistrix?: boolean; shopware?: boolean };
export const examples = (p: string, c: string, locale: Locale = DEFAULT_LOCALE, available: ExampleAvailability = {}): Example[] =>
  messages(locale).lib.examples(p, c).map((e, i) => ({ tag: EXAMPLE_TAGS[i], need: EXAMPLE_NEEDS[i], ...e })).filter(e => !e.need || available[e.need]).map(({ need: _need, ...e }) => e); // eslint-disable-line @typescript-eslint/no-unused-vars

/** Suggestion chips per context and language. */
export const suggestions = (kind: TargetKind, locale: Locale = DEFAULT_LOCALE): string[] => messages(locale).lib.suggestions[kind];

export const defaultPlaceholder = (locale: Locale = DEFAULT_LOCALE): string => messages(locale).lib.placeholder.default;
export const placeholderFor = (kind: TargetKind, name = '', locale: Locale = DEFAULT_LOCALE): string => {
  const t = messages(locale).lib.placeholder;
  return kind === 'landing' ? t.landing : t[kind](name);
};

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCALES, fromAcceptLanguage, localeFromCookieHeader, messages, resolveLocale } from '@/lib/i18n';
import { MESSAGES } from '@/lib/i18n/messages';

test('Accept-Language: Gewichte, Grundsprache, unbekannte Sprachen', () => {
  assert.equal(fromAcceptLanguage('en-US,en;q=0.9,de;q=0.8'), 'en');
  assert.equal(fromAcceptLanguage('fr-FR,fr;q=0.9,de;q=0.8,en;q=0.7'), 'de');
  assert.equal(fromAcceptLanguage('de;q=0.5,en;q=0.9'), 'en');
  assert.equal(fromAcceptLanguage('fr'), null);
  assert.equal(fromAcceptLanguage(''), null);
});

test('Cookie geht vor Accept-Language, Standard ist Deutsch', () => {
  assert.equal(resolveLocale('en', 'de'), 'en');
  assert.equal(resolveLocale('xx', 'en'), 'en');
  assert.equal(resolveLocale(undefined, null), 'de');
  assert.equal(localeFromCookieHeader('a=1; lotse_lang=en; b=2'), 'en');
  assert.equal(localeFromCookieHeader('lotse_lang=fr'), null);
});

// Jede Sprache hat dieselben Schlüssel wie Deutsch, keine leeren Texte, Funktionen bleiben Funktionen
function shape(v: unknown, path: string, out: Map<string, string>) {
  if (typeof v === 'function') out.set(path, 'fn');
  else if (typeof v === 'string') { assert.ok(v.trim(), `leerer Text: ${path}`); out.set(path, 'str'); }
  else if (Array.isArray(v)) v.forEach((x, i) => shape(x, `${path}[${i}]`, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) shape(x, path ? `${path}.${k}` : k, out);
  else out.set(path, typeof v);
}
test('Wörterbücher: alle Sprachen vollständig und gleich aufgebaut', () => {
  const ref = new Map<string, string>(); shape(MESSAGES.de, '', ref);
  for (const l of LOCALES) {
    const got = new Map<string, string>(); shape(MESSAGES[l], '', got);
    assert.deepEqual([...got.entries()].sort(), [...ref.entries()].sort(), l);
  }
  assert.equal(messages('en').common.minutesAgo(5), '5 min ago');
});

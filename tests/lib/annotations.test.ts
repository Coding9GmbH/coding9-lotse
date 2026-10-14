import assert from 'node:assert/strict';
import { test } from 'node:test';
import { annotationMessage, describeElement } from '../../src/lib/annotations';

test('element description: kind and short text', () => {
  assert.equal(describeElement('A', { text: 'Jetzt  kaufen', isButton: true }), 'Button „Jetzt kaufen“');
  assert.equal(describeElement('img', { alt: 'Vase aus Steinzeug' }), 'Bild „Vase aus Steinzeug“');
  assert.equal(describeElement('h2', { text: 'x'.repeat(80) }).length, 'Überschrift „“'.length + 58);
  assert.equal(describeElement('div', {}), 'Element');
});

test('message to Lotse: numbered, with section and path', () => {
  const msg = annotationMessage([
    { id: '1', label: 'Button „Jetzt kaufen“', section: 'Herbst', path: 'section.hero > a.btn', note: 'größer und dunkler ' },
    { id: '2', label: 'Bild „Vase“', path: 'section.split > img', note: 'anderes Foto' },
  ], 'draft');
  assert.match(msg, /^Änderungswünsche zum Entwurf/);
  assert.match(msg, /1\. Button „Jetzt kaufen“ \(Abschnitt „Herbst“\): größer und dunkler\n {3}Element: section\.hero > a\.btn/);
  assert.match(msg, /2\. Bild „Vase“: anderes Foto/);
});

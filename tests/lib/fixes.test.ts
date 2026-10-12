import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixForChat, rememberFix } from '../../src/lib/fixes';

test('Shop-Check-Befund ↔ Chat: neuester zuerst, je Befund ein Eintrag, Suche nach Chat', () => {
  let m = rememberFix({}, 'seo.meta', { chatId: 'c1', title: 'Meta fehlt', at: '2026-10-12T10:00:00Z' });
  m = rememberFix(m, 'bilder.alt', { chatId: 'c2', title: 'Alt-Texte', at: '2026-10-12T11:00:00Z' });
  m = rememberFix(m, 'seo.meta', { chatId: 'c3', title: 'Meta fehlt', at: '2026-10-12T12:00:00Z' });
  assert.deepEqual(Object.keys(m), ['seo.meta', 'bilder.alt']);
  assert.equal(m['seo.meta'].chatId, 'c3');
  assert.equal(fixForChat(m, 'c2')?.title, 'Alt-Texte');
  assert.equal(fixForChat(m, 'c1'), null);
  assert.equal(fixForChat(m, null), null);
});

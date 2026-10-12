import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixForChat, rememberFix, sentFix } from '../../src/lib/fixes';

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

test('rememberFix: höchstens 50 Einträge, die ältesten fallen weg', () => {
  let m = {};
  for (let i = 0; i < 60; i++) m = rememberFix(m, `f${i}`, { chatId: `c${i}`, title: 't', at: '' });
  const ids = Object.keys(m);
  assert.equal(ids.length, 50);
  assert.equal(ids[0], 'f59'); assert.equal(ids.at(-1), 'f10');
});

test('sentFix: Auftrag unverändert, ergänzt oder mit Anhängen gesendet zählt; etwas anderes nicht', () => {
  const prompt = 'Ergänze für alle Produkte ohne Meta-Description eine passende Beschreibung (max. 155 Zeichen).';
  assert.equal(sentFix(prompt, prompt), true);
  assert.equal(sentFix(prompt, `${prompt} Bitte im Sie-Ton.`), true);
  assert.equal(sentFix(prompt, `[Anhang: liste.csv]\n${prompt}`), true);
  assert.equal(sentFix(prompt, 'Senke alle Preise um 10 %'), false);
  assert.equal(sentFix(prompt, prompt.slice(0, 20)), false, 'nur ein Bruchstück');
  assert.equal(sentFix('', 'irgendwas'), false);
});

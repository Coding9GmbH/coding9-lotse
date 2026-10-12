import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KNOWLEDGE_LEAD } from './knowledge';

test('Wissensseite: lokal gespeichert, Auszüge gehen an den Modellanbieter', () => {
  assert.match(KNOWLEDGE_LEAD, /lokal/);
  assert.match(KNOWLEDGE_LEAD, /Anthropic oder OpenAI/);
  assert.doesNotMatch(KNOWLEDGE_LEAD, /Alles bleibt lokal/);
});

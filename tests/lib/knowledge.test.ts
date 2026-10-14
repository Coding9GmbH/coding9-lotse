import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KNOWLEDGE_LEAD } from '../../src/lib/knowledge';

test('knowledge base page: stored locally, excerpts go to the model provider', () => {
  assert.match(KNOWLEDGE_LEAD, /lokal/);
  assert.match(KNOWLEDGE_LEAD, /Anthropic oder OpenAI/);
  assert.doesNotMatch(KNOWLEDGE_LEAD, /Alles bleibt lokal/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterHistory, historyContexts, mergeChatPages, pageFull, rollChatPages, setupReady } from '../../src/lib/nav';
import type { Target } from '../../src/lib/protocol';

const chat = (title: string, name?: string) => ({ title, target: name ? ({ kind: 'category', id: name, name } as Target) : null });

test('setupReady: locked only when shop or AI are definitely missing', () => {
  assert.equal(setupReady({ shopware: true, ai: true }), true);
  assert.equal(setupReady({ shopware: true, ai: false }), false);
  assert.equal(setupReady({ shopware: false, ai: true }), false);
  assert.equal(setupReady({ shopware: false, ai: false }), false);
  assert.equal(setupReady(null), true, 'state unknown: do not lock');
  assert.equal(setupReady(undefined), true);
});

test('historyContexts: distinct contexts, newest first, only from two on', () => {
  const chats = [chat('a', 'Keramik'), chat('b'), chat('c', 'Wohnaccessoires'), chat('d', 'Keramik')];
  assert.deepEqual(historyContexts(chats), ['Keramik', 'Wohnaccessoires']);
  assert.deepEqual(historyContexts([chat('a', 'Keramik'), chat('b', 'Keramik'), chat('c')]), [], 'only one context: no filter');
  assert.deepEqual(historyContexts([]), []);
  const many = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map(n => chat(n, n));
  assert.deepEqual(historyContexts(many), ['A', 'B', 'C', 'D', 'E', 'F'], 'at most 6');
  assert.deepEqual(historyContexts(many, 3), ['A', 'B', 'C']);
});

test('filterHistory: exact context, search term in title or context, both combined', () => {
  const chats = [chat('Meta-Descriptions ergänzen', 'Keramik'), chat('Preise senken', 'Wohnaccessoires'), chat('FAQ für alle Produkte')];
  assert.equal(filterHistory(chats, '', null).length, 3);
  assert.deepEqual(filterHistory(chats, '', 'Keramik').map(c => c.title), ['Meta-Descriptions ergänzen']);
  assert.deepEqual(filterHistory(chats, '  PREISE ', null).map(c => c.title), ['Preise senken'], 'case-insensitive, trimmed');
  assert.deepEqual(filterHistory(chats, 'wohnacc', null).map(c => c.title), ['Preise senken'], 'also in the context name');
  assert.deepEqual(filterHistory(chats, 'preise', 'Keramik'), [], 'context and search together');
  assert.deepEqual(filterHistory(chats, '', 'Gibt es nicht'), []);
});

test('history paging: first page + older pages without duplicates; chats that slipped out move to the older ones', () => {
  const c = (...ids: string[]) => ids.map(id => ({ id }));
  const ids = (l: { id: string }[] | null) => l?.map(x => x.id);
  assert.equal(mergeChatPages(null, c('x')), null, 'without first page: nothing loaded yet');
  const first = c('a', 'b');
  assert.equal(mergeChatPages(first, []), first, 'without older pages unchanged (same reference)');
  assert.deepEqual(ids(mergeChatPages(c('z', 'a'), c('c', 'z', 'd'))), ['z', 'a', 'c', 'd'], 'refreshed chat appears only at the front');
  assert.deepEqual(rollChatPages(c('a', 'b'), c('n', 'a'), []), [], 'without older pages: remember nothing');
  assert.deepEqual(ids(rollChatPages(c('a', 'b'), c('n', 'a'), c('c', 'd'))), ['b', 'c', 'd'], 'b slipped out → at the front of the older ones');
  assert.deepEqual(ids(rollChatPages(c('a', 'b'), c('a'), c('c', 'b'), new Set(['b', 'c']))), [], 'deleted chats stay gone');
  const once = rollChatPages(c('a', 'b'), c('n', 'a'), c('c')), twice = rollChatPages(c('a', 'b'), c('n', 'a'), once);
  assert.deepEqual(ids(twice), ['b', 'c'], 'idempotent (React Strict Mode calls updaters twice)');
  assert.equal(pageFull(199), false); assert.equal(pageFull(200), true);
});

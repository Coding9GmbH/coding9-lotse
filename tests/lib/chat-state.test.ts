import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatReducer, initialChatState, isHome, isStillRunning, pendingQuestion, showPreview, stopControl, writeInFlight, type ChatState } from '../../src/lib/chat-state';
import type { ChangeSet, ChatDetail, ChatEvent } from '../../src/lib/protocol';

const cs: ChangeSet = {
  id: 'cs1', kind: 'products', entity: 'product', title: 'Preise senken', reason: '−20 %', atomic: false, skipped: [],
  items: [
    { id: 'a', entity: 'product', entityId: 'p1', label: 'Shirt', field: 'price', fieldLabel: 'Preis', before: '10,00', after: '8,00', warn: [] },
    { id: 'b', entity: 'product', entityId: 'p2', label: 'Hose', field: 'price', fieldLabel: 'Preis', before: '20,00', after: '16,00', warn: ['unter EK'] },
  ],
};

const events: ChatEvent[] = [
  { t: 'user', text: 'Senke Preise\n\n[Anhang: mediaId=m1, url=/staged/a.png, name=a]' },
  { t: 'start' },
  { t: 'text_start' },
  { t: 'text', text: 'Ich schaue ' },
  { t: 'text', text: 'nach.' },
  { t: 'tool', id: 't1', name: 'list_products', input: { term: 'x' } },
  { t: 'tool', id: 't2', name: 'get_product', input: { id: 'p1' } },
  { t: 'tool_result', id: 't1', error: false, preview: '2 Produkte' },
  { t: 'tool_result', id: 't2', error: true, preview: 'nicht erlaubt' },
  { t: 'question', approvalId: 'q1', question: 'Alle?', options: ['Ja', 'Nein'], answer: 'Ja' },
  { t: 'changeset', approvalId: 'c1', cs, decision: true },
  { t: 'changeset_result', csId: 'cs1', status: 'partial', results: [{ itemId: 'a', ok: true }, { itemId: 'b', ok: false, error: 'Fehler' }], undo: [{ op: 'patch', entity: 'product', id: 'p1' }] },
  { t: 'draft_partial', html: '<p>1</p>', name: 'Seite' },
  { t: 'draft', html: '<p>2</p>', spec: { a: 1 }, name: 'Seite', pageType: 'landingpage', audit: { score: 90, checks: [], warnings: [], stats: { words: 1, h1: 1, internalLinks: 0 } } },
  { t: 'focus', kind: 'category', id: 'c9', name: 'Schuhe', path: 'Herren › Schuhe', cmsPage: null },
  { t: 'done', error: null },
];

const replay = (evs: ChatEvent[], from: ChatState = initialChatState) => chatReducer(from, { type: 'replay', chat: { target: null, events: evs } });

test('replay builds the log in order', () => {
  const s = replay(events);
  assert.deepEqual(s.items.map(i => i.kind), ['user', 'ai', 'steps', 'question', 'changeset']);
  const [user, ai, steps, q, c] = s.items;
  assert.ok(user.kind === 'user' && user.text === 'Senke Preise' && user.attachments[0].url === '/staged/a.png');
  assert.ok(ai.kind === 'ai' && ai.text === 'Ich schaue nach.');
  assert.ok(steps.kind === 'steps' && steps.steps.map(x => x.state).join() === 'done,bad');
  assert.ok(q.kind === 'question' && q.answer === 'Ja' && !q.interactive && q.options[0].label === 'Ja');
  assert.ok(c.kind === 'changeset' && c.result?.status === 'partial' && !c.interactive);
  assert.equal(s.draft?.html, '<p>2</p>');
  assert.equal(s.draft?.partial, false);
  assert.equal(s.tab, 'prev');
  assert.equal(s.target?.id, 'c9');
  assert.equal(s.busy, false);
  assert.ok(!isHome(s) && showPreview(s));
});

test('live and replay produce the same log', () => {
  let live = chatReducer(initialChatState, { type: 'run_start', text: (events[0] as { text: string }).text });
  for (const ev of events.slice(1)) live = chatReducer(live, { type: 'event', event: ev, mode: 'live' });
  live = chatReducer(live, { type: 'run_end' });
  const rep = replay(events);
  const strip = (s: ChatState) => s.items.map(i => ({ ...i, interactive: undefined }));
  assert.deepEqual(strip(live), strip(rep));
  assert.equal(live.status, null);
});

test('open question/change set: interactive live, not in replay', () => {
  const evs: ChatEvent[] = [
    { t: 'question', approvalId: 'q1', question: 'Welche?', options: ['A'], optionHints: ['x'] },
    { t: 'changeset', approvalId: 'c1', cs },
  ];
  let live: ChatState = { ...initialChatState, busy: true };
  for (const ev of evs) live = chatReducer(live, { type: 'event', event: ev });
  assert.equal(pendingQuestion(live)?.approvalId, 'q1');
  assert.equal(live.status, 'Wartet auf deine Freigabe');
  const q = live.items[0];
  assert.ok(q.kind === 'question' && q.options[0].description === 'x');

  live = chatReducer(live, { type: 'answer', approvalId: 'q1', answer: 'A' });
  assert.equal(pendingQuestion(live), null);
  live = chatReducer(live, { type: 'decide', approvalId: 'c1', allow: true, selected: ['a'] });
  const c = live.items[1];
  assert.ok(c.kind === 'changeset' && !c.interactive && c.sent?.allow && c.sent.selected?.[0] === 'a');
  assert.equal(live.status, 'Wendet Änderungen an …');
  assert.equal(writeInFlight(live), true);
  const writing = stopControl(true);
  assert.equal(writing.stops, false);
  assert.match(writing.title, /läuft weiter/);
  assert.doesNotMatch(writing.title, /nichts geschrieben/);
  live = chatReducer(live, { type: 'event', event: { t: 'changeset_result', csId: 'cs1', status: 'applied', results: [] } });
  assert.equal(writeInFlight(live), false);
  assert.equal(stopControl(false).stops, true);
  assert.match(stopControl(false).title, /nichts geschrieben/);

  const rep = replay(evs);
  assert.ok(rep.items.every(i => !('interactive' in i) || !i.interactive));
});

test('publishing a landing page sets the live preview', () => {
  const pub: ChatEvent[] = [
    { t: 'changeset', approvalId: 'c2', cs: { ...cs, id: 'cs2', kind: 'page', items: [] } },
    { t: 'changeset_result', csId: 'cs2', status: 'applied', results: [], published: { adminUrl: 'https://a/admin', storefront: 'https://shop.test/sommer', name: 'Sommer' } },
  ];
  const s = chatReducer(initialChatState, { type: 'replay', chat: { target: { kind: 'landing', name: 'Neue Landingpage' }, events: pub } });
  assert.equal(s.items.at(-1)?.kind, 'published');
  assert.equal(s.liveOverride, '/shop/sommer');
  assert.equal(s.liveBust, 1);
});

test('error from done and new text after a tool opens a new bubble', () => {
  const s = replay([
    { t: 'text', text: 'a' }, { t: 'tool', id: 'x', name: 'n', input: {} }, { t: 'text', text: 'b' }, { t: 'done', error: 'kaputt' },
  ]);
  assert.deepEqual(s.items.map(i => i.kind), ['ai', 'steps', 'ai', 'error']);
});

test('reset keeps the styleguide', () => {
  const sg = { brandName: 'X' } as never;
  let s = chatReducer(initialChatState, { type: 'set_styleguide', sg });
  s = replay(events, s);
  s = chatReducer(s, { type: 'reset' });
  assert.equal(s.items.length, 0);
  assert.equal(s.styleguide, sg);
  assert.ok(isHome(s));
});

test('reconnect with a running turn: open approval becomes interactive again, completed one does not', () => {
  const set = (id: string): ChangeSet => ({ ...cs, id });
  const chat: ChatDetail = { id: 'c', title: 't', target: null, events: [
    { t: 'user', text: 'a' },
    { t: 'changeset', approvalId: 'x1', cs: set('alt'), decision: true },
    { t: 'changeset', approvalId: 'x2', cs: set('offen') },
  ] };
  let s = chatReducer(initialChatState, { type: 'replay', chat });
  const sets = () => s.items.filter(i => i.kind === 'changeset').map(i => i.kind === 'changeset' && i.interactive);
  assert.deepEqual(sets(), [false, false]);
  s = chatReducer(s, { type: 'resume', last: chat.events.at(-1) });
  assert.deepEqual(sets(), [false, true]);
  assert.equal(s.busy, true);
  assert.equal(s.status, 'Wartet auf deine Freigabe');
});

test('progress of large change sets: live on the set, status shows numbers, result ends it', () => {
  let s = chatReducer(initialChatState, { type: 'run_start', text: 'Preise' });
  s = chatReducer(s, { type: 'event', event: { t: 'changeset', approvalId: 'c1', cs } });
  s = chatReducer(s, { type: 'decide', approvalId: 'c1', allow: true });
  s = chatReducer(s, { type: 'event', event: { t: 'changeset_progress', csId: 'cs1', done: 1250, total: 2400 } });
  const item = s.items.find(i => i.kind === 'changeset');
  assert.ok(item?.kind === 'changeset' && item.progress?.done === 1250 && item.progress.total === 2400);
  assert.equal(s.status, 'Wendet an: 1.250 / 2.400');
  s = chatReducer(s, { type: 'event', event: { t: 'changeset_result', csId: 'cs1', status: 'applied', results: [] } });
  s = chatReducer(s, { type: 'event', event: { t: 'changeset_progress', csId: 'cs1', done: 2400, total: 2400 } });
  const done = s.items.find(i => i.kind === 'changeset');
  assert.ok(done?.kind === 'changeset' && done.result && done.progress?.done === 1250);
});

test('reconnect: snapshot reports "running" but the log already ends with done → not busy', () => {
  const evs: ChatEvent[] = [{ t: 'user', text: 'a' }, { t: 'text_start' }, { t: 'text', text: 'fertig' }, { t: 'done', error: null }];
  const chat: ChatDetail = { id: 'c', title: 't', target: null, events: evs };
  assert.equal(isStillRunning({ running: true, chat }), false, 'done at the end: turn is over');
  assert.equal(isStillRunning({ running: false, chat }), false);
  assert.equal(isStillRunning({ running: true, chat: { events: evs.slice(0, -1) } }), true, 'without done it is still running');
  assert.equal(isStillRunning({ running: true, chat: { events: [] } }), true);
  // Replay without resume: not busy, no status, no error bubble
  const s = replay(evs);
  assert.equal(s.busy, false);
  assert.equal(s.status, null);
  assert.deepEqual(s.items.map(i => i.kind), ['user', 'ai']);
});

test('reconnect with a running turn: done ends it (busy off, status empty, no error bubble for error null)', () => {
  const chat: ChatDetail = { id: 'c', title: 't', target: null, events: [
    { t: 'user', text: 'a' },
    { t: 'question', approvalId: 'q1', question: 'Welche?', options: ['A'], answer: 'A' },
    { t: 'tool', id: 't1', name: 'list_products', input: {} },
  ] };
  let s = chatReducer(initialChatState, { type: 'replay', chat });
  s = chatReducer(s, { type: 'resume', last: chat.events.at(-1) });
  assert.equal(s.busy, true);
  assert.equal(s.status, 'Produkte analysieren …');
  assert.equal(pendingQuestion(s), null, 'answered question does not become interactive again');
  s = chatReducer(s, { type: 'event', event: { t: 'done', error: null } });
  s = chatReducer(s, { type: 'run_end' });
  assert.equal(s.busy, false);
  assert.equal(s.status, null);
  assert.deepEqual(s.items.map(i => i.kind), ['user', 'question', 'steps']);
});

test('unsend: rejected message (409) disappears again, state is not busy', () => {
  let s = replay([{ t: 'user', text: 'alt' }, { t: 'text_start' }, { t: 'text', text: 'ok' }, { t: 'done', error: null }]);
  s = chatReducer(s, { type: 'run_start', text: 'neu' });
  assert.equal(s.busy, true);
  assert.equal(s.items.length, 3);
  s = chatReducer(s, { type: 'unsend' });
  assert.deepEqual(s.items.map(i => i.kind), ['user', 'ai']);
  assert.equal(s.busy, false);
  assert.equal(s.status, null);
  assert.equal(chatReducer(s, { type: 'unsend' }).items.length, 2, 'without a user bubble at the end nothing happens');
});

test('publishing on a category: live layout name + reload preview, no override in replay', () => {
  const pub: ChatEvent[] = [
    { t: 'changeset', approvalId: 'c3', cs: { ...cs, id: 'cs3', kind: 'page', items: [] } },
    { t: 'changeset_result', csId: 'cs3', status: 'applied', results: [], published: { adminUrl: 'https://a/admin', name: 'Sommer-Layout' } },
  ];
  const target = { kind: 'category' as const, id: 'c1', name: 'Sommer', path: 'Sommer', cmsPage: null };
  let live: ChatState = { ...initialChatState, target, tab: 'prev', busy: true };
  for (const ev of pub) live = chatReducer(live, { type: 'event', event: ev, mode: 'live' });
  assert.equal(live.target?.cmsPage, 'Sommer-Layout');
  assert.deepEqual(live.cmsOverrides, { c1: 'Sommer-Layout' });
  assert.equal(live.liveBust, 1);
  assert.equal(live.tab, 'live');
  assert.equal(live.liveOverride, null, 'category keeps its own page');
  assert.equal(live.items.at(-1)?.kind, 'published');

  const rep = chatReducer(initialChatState, { type: 'replay', chat: { target, events: pub } });
  assert.deepEqual(rep.cmsOverrides, {});
  assert.equal(rep.target?.cmsPage, null);
  assert.equal(rep.liveBust, 1);
  assert.equal(rep.tab, 'live', 'without a draft: real page');
});

test('select_target and focus: draft stays on deselect, another context clears it, same ID changes nothing', () => {
  const s0 = replay(events);
  assert.ok(s0.draft && s0.target?.id === 'c9');
  const s1 = chatReducer({ ...s0, liveOverride: '/shop/x' }, { type: 'select_target', target: null });
  assert.ok(s1.draft, 'draft stays visible without a target');
  assert.equal(s1.target, null);
  assert.equal(s1.liveOverride, null);
  assert.equal(s1.tab, 'live');
  const s2 = chatReducer(s0, { type: 'select_target', target: { kind: 'product', id: 'p7', name: 'Lampe' } });
  assert.equal(s2.draft, null);
  assert.equal(s2.target?.id, 'p7');
  const same = chatReducer(s0, { type: 'event', event: { t: 'focus', kind: 'category', id: 'c9', name: 'Anders', path: null, cmsPage: null } });
  assert.equal(same, s0, 'focus with the same ID leaves the state unchanged');
  const other = chatReducer(s0, { type: 'event', event: { t: 'focus', kind: 'product', id: 'p1', name: 'Shirt', path: null, cmsPage: 'L' } });
  assert.deepEqual(other.target, { kind: 'product', id: 'p1', name: 'Shirt', path: null, cmsPage: 'L' });
});

test('undo action with undoResults: result carries the outcome per step, button stays usable (idle) until everything is reverted', () => {
  const replayed = chatReducer(initialChatState, { type: 'replay', chat: { target: null, events } });
  const cards = (s: ChatState) => s.items.filter(i => i.kind === 'changeset');
  const part = chatReducer(replayed, { type: 'undo', csId: 'cs1', phase: 'idle', undoResults: [{ ok: false, error: 'kaputt' }] });
  const c1 = cards(part)[0];
  assert.ok(c1.kind === 'changeset' && c1.undo === 'idle' && c1.result?.undone === false);
  assert.deepEqual(c1.kind === 'changeset' && c1.result?.undoResults, [{ ok: false, error: 'kaputt' }]);
  const done = chatReducer(part, { type: 'undo', csId: 'cs1', phase: 'done', undoResults: [{ ok: true }] });
  const c2 = cards(done)[0];
  assert.ok(c2.kind === 'changeset' && c2.undo === 'done' && c2.result?.undone === true);
  const plain = chatReducer(part, { type: 'undo', csId: 'cs1', phase: 'running' });
  assert.deepEqual(cards(plain)[0].kind === 'changeset' && cards(plain)[0].result?.undoResults, [{ ok: false, error: 'kaputt' }], 'without undoResults the result stays as it was');
});

test('steps without tool_result are closed by done/run_end/replay; replay with a running turn reopens them via resume', () => {
  const steps = (s: ChatState) => s.items.flatMap(i => (i.kind === 'steps' ? i.steps : []));
  const events: ChatEvent[] = [
    { t: 'user', text: 'Hallo' },
    { t: 'tool', id: 'a', name: 'get_product', input: {} },
    { t: 'tool', id: 'b', name: 'read_page', input: {} },
    { t: 'tool_result', id: 'a', error: false, preview: 'ok' },
  ];
  const open = chatReducer(initialChatState, { type: 'replay', chat: { target: null, events } });
  assert.deepEqual(steps(open).map(x => x.state), ['done', 'done'], 'reloaded: nothing blinks');
  assert.equal(steps(open)[1].stale, true);
  assert.deepEqual(steps(chatReducer(open, { type: 'resume' })).map(x => x.state), ['done', 'run'], 'turn still running: open step runs again');

  const live = events.reduce((s, ev) => chatReducer(s, { type: 'event', event: ev, mode: 'live' }), { ...initialChatState, busy: true });
  assert.deepEqual(steps(live).map(x => x.state), ['done', 'run']);
  assert.deepEqual(steps(chatReducer(live, { type: 'event', event: { t: 'done', error: null }, mode: 'live' })).map(x => x.state), ['done', 'done']);
  assert.deepEqual(steps(chatReducer(live, { type: 'event', event: { t: 'done', error: 'kaputt' }, mode: 'live' })).map(x => x.state), ['done', 'bad']);
  assert.deepEqual(steps(chatReducer(live, { type: 'run_end' })).map(x => x.state), ['done', 'done']);
});

test('code chat cards: file changes, a command updated in place, sandbox status as one line, proposal; replay looks like live', () => {
  const evs: ChatEvent[] = [
    { t: 'user', text: 'Header grün' },
    { t: 'sandbox_status', state: 'waking' },
    { t: 'sandbox_status', state: 'ready' },
    { t: 'tool', id: 'a', name: 'write_file', input: {} },
    { t: 'tool_result', id: 'a', error: false, preview: 'ok' },
    { t: 'file_change', path: 'src/x.twig', kind: 'create', added: 3, removed: 0 },
    { t: 'command', id: 'c1', command: 'theme-compile', status: 'running' },
    { t: 'command', id: 'c1', command: 'theme-compile', status: 'ok', exitCode: 0, tail: 'done', ms: 7100 },
    { t: 'preview_reload' },
    { t: 'publish_proposal', title: 'Header', body: 'grün' },
    { t: 'done', error: null },
  ];
  let live: ChatState = { ...initialChatState, busy: true };
  for (const ev of evs) live = chatReducer(live, { type: 'event', event: ev });
  assert.deepEqual(live.items.map(i => i.kind), ['user', 'sandbox', 'steps', 'file', 'command', 'publish']);
  const cmd = live.items.find(i => i.kind === 'command');
  assert.ok(cmd?.kind === 'command' && cmd.status === 'ok' && cmd.ms === 7100);
  assert.ok(live.items[1].kind === 'sandbox' && live.items[1].state === 'ready');
  assert.equal(live.previewReload, 1);
  const r = replay(evs.filter(e => e.t !== 'preview_reload'));
  assert.deepEqual(r.items.map(i => i.kind), live.items.map(i => i.kind));
  assert.equal(r.previewReload, 0, 'replay does not reload the preview');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CodeTaskPublic, QuickStartPublic } from '../../src/lib/protocol';
import { messages } from '../../src/lib/i18n';
import { applyTaskEvent, canRetryFrom, choiceKey, demoRequest, displayStatus, draftOf, offerChoice, orderedEnvironments, quickSetupOf, quickSummary, startChoices, errorSummary, followStartPath, formatSeconds, newerTask, statusTone, stepSeconds } from '../../src/lib/sandbox-task';

// Task view state: snapshot replaces, log lines append to their step (capped), deleted clears; status pips and durations.
const task = (o: Partial<CodeTaskPublic> = {}): CodeTaskPublic => ({
  id: 't_aaaaaaaaaaaa', title: 'T', goal: '', repo: 'a/b', baseBranch: 'main', branch: 'lotse/t-aaaaaa', template: 'dockware', status: 'setting_up',
  steps: [{ id: 'clone', key: 'clone', state: 'running', log: [] }, { id: 'ready', key: 'ready', state: 'pending', log: [] }],
  layout: null, error: null, container: null, preview: '/sbx/t_aaaaaaaaaaaa.0123456789abcdef0123', dump: null, prUrl: null, createdAt: '', updatedAt: '', lastActiveAt: '', finishedAt: null, chatId: null, pluginName: null, pr: null, publish: null, internet: null, shots: [], ...o,
});

test('applyTaskEvent: snapshot, log lines (max. 200), deleted', () => {
  let t = applyTaskEvent(null, { t: 'task', task: task() });
  for (let i = 0; i < 205; i++) t = applyTaskEvent(t, { t: 'log', step: 'clone', line: `l${i}` });
  assert.equal(t!.steps[0].log.length, 200);
  assert.equal(t!.steps[0].log.at(-1), 'l204');
  assert.deepEqual(t!.steps[1].log, []);
  assert.equal(applyTaskEvent(null, { t: 'log', step: 'clone', line: 'x' }), null);
  assert.equal(applyTaskEvent(t, { t: 'deleted' }), null);
});

test('status tone, durations, retry only from a failed/interrupted step of a stopped task', () => {
  assert.deepEqual((['setting_up', 'waking', 'ready', 'paused', 'failed', 'interrupted', 'done'] as const).map(statusTone), ['busy', 'busy', 'ok', 'idle', 'bad', 'idle', 'done']);
  assert.equal(stepSeconds({ startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:01:05Z' }), 65);
  assert.equal(stepSeconds({}), null);
  assert.equal(formatSeconds(65), '1:05 min');
  assert.equal(formatSeconds(7), '7 s');
  const failed = task({ status: 'failed', steps: [{ id: 'clone', key: 'clone', state: 'failed', log: [] }] });
  assert.ok(canRetryFrom(failed, failed.steps[0]));
  assert.ok(!canRetryFrom({ ...failed, status: 'setting_up' }, failed.steps[0]));
});

test('a setup waiting for the approval of the repository file\'s commands is shown as waiting, not as an error', () => {
  const file = { commands: [], env: [], ignored: [], hash: 'h' };
  const waiting = task({ status: 'failed', repoFile: { ...file, state: 'pending' } });
  assert.equal(displayStatus(waiting), 'approval');
  assert.equal(statusTone(displayStatus(waiting)), 'wait');
  assert.equal(displayStatus({ ...waiting, repoFile: { ...waiting.repoFile!, state: 'approved' } }), 'failed');
  assert.equal(displayStatus({ ...waiting, status: 'setting_up' }), 'setting_up');
  assert.equal(displayStatus(task({ status: 'failed' })), 'failed');
});

test('followStartPath: the preview takes the repository\'s start page once known, unless the user went elsewhere', () => {
  assert.equal(followStartPath('/', undefined, '/de/'), '/de/');
  assert.equal(followStartPath('/de/', '/de/', '/en/'), '/en/');
  assert.equal(followStartPath('/checkout/cart', undefined, '/de/'), '/checkout/cart');
  assert.equal(followStartPath('/de/', '/de/', undefined), '/');
});

test('errorSummary: the first line of the step and the first output line that says why, without trace noise', () => {
  const trace = '„Shop-Name setzen“ fehlgeschlagen (Exit-Code 1):\n\nIn Application.php line 666:\n\n  There are no commands defined in the "demo" namespace.  \n\n#0 /var/www/html/vendor/x.php(12): run()\n#1 {main}';
  assert.equal(errorSummary(trace), '„Shop-Name setzen“ fehlgeschlagen (Exit-Code 1): There are no commands defined in the "demo" namespace.');
  assert.equal(errorSummary('Zeitüberschreitung nach 10 Min.'), 'Zeitüberschreitung nach 10 Min.');
  assert.equal(errorSummary('„bin/console theme:compile“ fehlgeschlagen (Exit-Code 2):\n[RuntimeException]\nScss error'), '„bin/console theme:compile“ fehlgeschlagen (Exit-Code 2): Scss error');
});

test('newerTask: an action response never replaces a newer state from the stream', () => {
  const ready = task({ status: 'ready', updatedAt: '2026-10-17T10:00:02.000Z' }), waking = task({ status: 'waking', updatedAt: '2026-10-17T10:00:01.000Z' });
  assert.equal(newerTask(ready, waking), ready);
  assert.equal(newerTask(waking, ready), ready);
  assert.equal(newerTask(null, waking), waking);
});

test('A22: a quick start is the dialog’s request – kept without chat, title and file decision, and back into the dialog’s state', () => {
  const req = { repo: 'acme/shop', baseBranch: 'main', title: 'Footer', dumpId: 'd_x', skipRepoHash: 'a'.repeat(64), mode: 'custom' as const, targetPath: '/opt/shop',
    commands: [{ label: 'Bauen', command: 'make', phase: 'final' as const }], env: [{ key: 'A', value: '1' }], image: '6.7.14.0', previewPath: '/de/', notes: 'n' };
  const kept = quickSetupOf('existing', req, true);
  assert.deepEqual(kept, { kind: 'existing', repo: 'acme/shop', baseBranch: 'main', dumpId: 'd_x', mode: 'custom', targetPath: '/opt/shop', commands: req.commands, env: req.env, image: '6.7.14.0', previewPath: '/de/', notes: 'n', envRefs: [] });
  assert.equal(quickSetupOf('existing', req, false).dumpId, undefined, 'a one-off upload is not kept');
  // references to the environment's variables travel with the setup (also when empty: the server keeps them only while sent)
  assert.deepEqual(quickSetupOf('existing', req, true, ['STRIPE_KEY']).envRefs, ['STRIPE_KEY']);
  assert.deepEqual(quickSetupOf('none', { repo: '', baseBranch: '', source: 'none' }, false, ['STRIPE_KEY']).envRefs, []);
  assert.deepEqual(draftOf({ kind: 'existing', repo: 'acme/shop', baseBranch: 'main', envRefs: ['STRIPE_KEY'] }).envRefs, ['STRIPE_KEY']);
  assert.equal(draftOf({ kind: 'existing', repo: 'acme/shop', baseBranch: 'main', envRefs: ['STRIPE_KEY'] }).advanced, true);
  assert.deepEqual(draftOf(kept), { kind: 'existing', repo: 'acme/shop', baseBranch: 'main', pluginName: '', custom: true, targetPath: '/opt/shop', commands: req.commands, vars: req.env, envRefs: [],
    dumpId: 'd_x', image: '6.7.14.0', previewPath: '/de/', notes: 'n', advanced: true });
  // the plain cases: nothing in "Erweitert", demo data
  assert.deepEqual(draftOf({ kind: 'existing', repo: 'acme/shop', baseBranch: 'main' }), { kind: 'existing', repo: 'acme/shop', baseBranch: 'main', pluginName: '', custom: false, targetPath: null, commands: [], vars: [], envRefs: [], dumpId: null, image: '', previewPath: '', notes: '', advanced: false });
  const none = draftOf({ kind: 'none', repo: 'x/y', baseBranch: 'main', source: 'none', pluginName: 'VersandHinweis' });
  assert.equal(none.repo, '');
  assert.equal(none.pluginName, 'VersandHinweis');
  assert.equal(draftOf({ kind: 'custom', repo: 'a/b', baseBranch: 'main', mode: 'custom', targetPath: '/srv/b' }).advanced, true);
});

// A23: one choice list everywhere – saved environments (the default first, then by name) → demo shop → "Neu einrichten …"
test('start choices: order, the AI card’s preselection, the demo request, the summary', () => {
  const env = (id: string, name: string, def = false, setup: QuickStartPublic['setup'] = { kind: 'existing', repo: 'acme/shop', baseBranch: 'main' }): QuickStartPublic =>
    ({ id, name, setup, default: def, createdAt: '', updatedAt: '', createdBy: null, lastUsedAt: null });
  const list = [env('qs_b', 'Zeta'), env('qs_c', 'alpha'), env('qs_a', 'Mitte', true)];
  assert.deepEqual(orderedEnvironments(list).map(q => q.name), ['Mitte', 'alpha', 'Zeta']);
  assert.deepEqual(startChoices(list).map(choiceKey), ['qs_a', 'qs_c', 'qs_b', 'demo', 'new']);
  assert.deepEqual(startChoices([]).map(choiceKey), ['demo', 'new']);
  // the card: the AI's environment (if still saved) → "Neu einrichten …" for a proposed repository → the default → the demo shop
  assert.deepEqual(offerChoice({ quickStartId: 'qs_c', repo: 'acme/shop' }, list), { type: 'env', id: 'qs_c' });
  assert.equal(offerChoice({ quickStartId: 'qs_gone', repo: '' }, list), null); // gone: nothing preselected, the user picks
  assert.equal(offerChoice({ quickStartId: 'qs_gone', repo: 'acme/shop' }, list), null);
  assert.deepEqual(offerChoice({ repo: 'acme/other' }, list), { type: 'new' });
  assert.deepEqual(offerChoice({ repo: '' }, list.filter(q => !q.default)), { type: 'demo' });
  assert.deepEqual(demoRequest('c1', 'Demo-Shop'), { chatId: 'c1', repo: '', baseBranch: '', source: 'none', title: 'Demo-Shop' });
  const de = messages('de'), en = messages('en');
  assert.equal(quickSummary({ kind: 'existing', repo: 'acme/shop', baseBranch: 'main', dumpId: 'd_1', image: 'dockware/shopware:6.7.14.0' }, de, id => (id === 'd_1' ? 'live.sql' : null)),
    'Bestehendes Projekt · acme/shop @ main · live.sql · Image 6.7.14.0');
  assert.equal(quickSummary({ kind: 'none', repo: '', baseBranch: '' }, en), 'Start without a project · Plugin SandboxPlugin, local git only · Demo data');
  assert.equal(quickSummary({ kind: 'existing', repo: 'a/b', baseBranch: 'dev', dumpId: 'd_x' }, de), 'Bestehendes Projekt · a/b @ dev · Gespeicherte Datenbank');
});

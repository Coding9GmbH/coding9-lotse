import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CodeTaskPublic } from '../../src/lib/protocol';
import { applyTaskEvent, canRetryFrom, formatSeconds, statusTone, stepSeconds } from '../../src/lib/sandbox-task';

// Task view state: snapshot replaces, log lines append to their step (capped), deleted clears; status pips and durations.
const task = (o: Partial<CodeTaskPublic> = {}): CodeTaskPublic => ({
  id: 't_aaaaaaaaaaaa', title: 'T', goal: '', repo: 'a/b', baseBranch: 'main', branch: 'lotse/t-aaaaaa', template: 'dockware', status: 'setting_up',
  steps: [{ id: 'clone', key: 'clone', state: 'running', log: [] }, { id: 'ready', key: 'ready', state: 'pending', log: [] }],
  layout: null, error: null, container: null, preview: '/sbx/t_aaaaaaaaaaaa.0123456789abcdef0123', prUrl: null, createdAt: '', updatedAt: '', lastActiveAt: '', finishedAt: null, ...o,
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

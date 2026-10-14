import '../isolate-data';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { formatLog, log, setLogSinkForTests, urlForLog } from '../../src/server/log';
import { updateSettings } from '../../src/server/settings';
import { fetchWithRetry } from '../../src/server/retry';

const lines: { stream: string; line: string }[] = [];
const capture = () => { lines.length = 0; setLogSinkForTests((stream, line) => lines.push({ stream, line })); };
afterEach(() => { setLogSinkForTests(null); delete process.env.LOTSE_LOG_FORMAT; delete process.env.LOTSE_LOG_LEVEL; });

test('JSON format: ts, level, msg, chatId and extra fields on one line', () => {
  process.env.LOTSE_LOG_FORMAT = 'json';
  const o = JSON.parse(formatLog('info', 'Chat-Runde beendet', { chatId: 'c1', ms: 12, usage: { input: 3 } }, new Date('2026-01-02T03:04:05.000Z')));
  assert.deepEqual(o, { ts: '2026-01-02T03:04:05.000Z', level: 'info', msg: 'Chat-Runde beendet', chatId: 'c1', ms: 12, usage: { input: 3 } });
});

test('readable format: time, level, text, key=value', () => {
  const l = formatLog('warn', 'Shop-Anfrage fehlgeschlagen', { status: 503, url: 'shop.test/api', error: 'zwei Wörter' }, new Date('2026-01-02T03:04:05.000Z'));
  assert.equal(l, '2026-01-02T03:04:05.000Z WARN  Shop-Anfrage fehlgeschlagen status=503 url=shop.test/api error="zwei Wörter"');
});

test('no secrets: stored credentials, Bearer/sk tokens, fields with secret names, errors only as text', () => {
  updateSettings({ shopware: { url: 'https://shop.test', clientId: 'id', clientSecret: 'GEHEIM-shopware-42' } } as never);
  process.env.LOTSE_LOG_FORMAT = 'json';
  const l = formatLog('error', 'kaputt: GEHEIM-shopware-42', { chatId: 'c', error: new Error('Bearer abcdefghijklmnopqrstuvwxyz'), apiKey: 'x-123', password: 'pw', nested: { token: 'tok', inputTokens: 5 }, key: 'sk-abcdefghijklmnopqrstu' });
  assert.doesNotMatch(l, /GEHEIM-shopware-42|abcdefghijklmnopqrstuvwxyz|x-123|"pw"|"tok"|sk-abcdefghijklmnopqrstu/);
  const o = JSON.parse(l);
  assert.equal(o.apiKey, '•••'); assert.equal(o.nested.token, '•••'); assert.equal(o.nested.inputTokens, 5, 'numbers (token usage) stay');
  assert.equal(o.error, 'Bearer •••');
});

test('level: default info, LOTSE_LOG_LEVEL filters; warn/error to stderr', () => {
  capture();
  log.debug('d'); log.info('i'); log.warn('w'); log.error('e');
  assert.deepEqual(lines.map(l => l.stream), ['stdout', 'stderr', 'stderr']);
  capture(); process.env.LOTSE_LOG_LEVEL = 'warn'; log.info('i'); log.warn('w');
  assert.equal(lines.length, 1);
  capture(); process.env.LOTSE_LOG_LEVEL = 'debug'; log.debug('d');
  assert.equal(lines.length, 1);
  capture(); process.env.LOTSE_LOG_LEVEL = 'silent'; log.error('e');
  assert.equal(lines.length, 0);
  capture(); process.env.LOTSE_LOG_LEVEL = 'quatsch'; log.debug('d'); log.info('i');
  assert.equal(lines.length, 1, 'unknown = info');
});

test('urlForLog: without query (tokens)', () => {
  assert.equal(urlForLog('https://shop.test/api/search?access_token=geheim'), 'shop.test/api/search');
  assert.equal(urlForLog('kaputt'), '?');
});

test('fetchWithRetry logs retry and final failure', async () => {
  capture(); process.env.LOTSE_LOG_FORMAT = 'json';
  const r = await fetchWithRetry(async () => new Response('x', { status: 503 }), { attempts: 2, baseMs: 1, label: 'gsc' });
  assert.equal(r.status, 503);
  const o = lines.map(l => JSON.parse(l.line));
  assert.deepEqual(o.map(x => [x.level, x.api, x.status]), [['info', 'gsc', 503], ['warn', 'gsc', 503]]);
});

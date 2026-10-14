import '../isolate-data';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { formatLog, log, setLogSinkForTests, urlForLog } from '../../src/server/log';
import { updateSettings } from '../../src/server/settings';
import { fetchWithRetry } from '../../src/server/retry';

const lines: { stream: string; line: string }[] = [];
const capture = () => { lines.length = 0; setLogSinkForTests((stream, line) => lines.push({ stream, line })); };
afterEach(() => { setLogSinkForTests(null); delete process.env.LOTSE_LOG_FORMAT; delete process.env.LOTSE_LOG_LEVEL; });

test('JSON-Format: ts, level, msg, chatId und Zusatzfelder in einer Zeile', () => {
  process.env.LOTSE_LOG_FORMAT = 'json';
  const o = JSON.parse(formatLog('info', 'Chat-Runde beendet', { chatId: 'c1', ms: 12, usage: { input: 3 } }, new Date('2026-01-02T03:04:05.000Z')));
  assert.deepEqual(o, { ts: '2026-01-02T03:04:05.000Z', level: 'info', msg: 'Chat-Runde beendet', chatId: 'c1', ms: 12, usage: { input: 3 } });
});

test('lesbares Format: Zeit, Level, Text, key=value', () => {
  const l = formatLog('warn', 'Shop-Anfrage fehlgeschlagen', { status: 503, url: 'shop.test/api', error: 'zwei Wörter' }, new Date('2026-01-02T03:04:05.000Z'));
  assert.equal(l, '2026-01-02T03:04:05.000Z WARN  Shop-Anfrage fehlgeschlagen status=503 url=shop.test/api error="zwei Wörter"');
});

test('keine Geheimnisse: gespeicherte Zugangsdaten, Bearer-/sk-Tokens, Felder mit Geheimnis-Namen, Fehler nur als Text', () => {
  updateSettings({ shopware: { url: 'https://shop.test', clientId: 'id', clientSecret: 'GEHEIM-shopware-42' } } as never);
  process.env.LOTSE_LOG_FORMAT = 'json';
  const l = formatLog('error', 'kaputt: GEHEIM-shopware-42', { chatId: 'c', error: new Error('Bearer abcdefghijklmnopqrstuvwxyz'), apiKey: 'x-123', password: 'pw', nested: { token: 'tok', inputTokens: 5 }, key: 'sk-abcdefghijklmnopqrstu' });
  assert.doesNotMatch(l, /GEHEIM-shopware-42|abcdefghijklmnopqrstuvwxyz|x-123|"pw"|"tok"|sk-abcdefghijklmnopqrstu/);
  const o = JSON.parse(l);
  assert.equal(o.apiKey, '•••'); assert.equal(o.nested.token, '•••'); assert.equal(o.nested.inputTokens, 5, 'Zahlen (Token-Verbrauch) bleiben');
  assert.equal(o.error, 'Bearer •••');
});

test('Level: Standard info, LOTSE_LOG_LEVEL filtert; warn/error nach stderr', () => {
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
  assert.equal(lines.length, 1, 'unbekannt = info');
});

test('urlForLog: ohne Query (Tokens)', () => {
  assert.equal(urlForLog('https://shop.test/api/search?access_token=geheim'), 'shop.test/api/search');
  assert.equal(urlForLog('kaputt'), '?');
});

test('fetchWithRetry protokolliert Wiederholung und endgültiges Scheitern', async () => {
  capture(); process.env.LOTSE_LOG_FORMAT = 'json';
  const r = await fetchWithRetry(async () => new Response('x', { status: 503 }), { attempts: 2, baseMs: 1, label: 'gsc' });
  assert.equal(r.status, 503);
  const o = lines.map(l => JSON.parse(l.line));
  assert.deepEqual(o.map(x => [x.level, x.api, x.status]), [['info', 'gsc', 503], ['warn', 'gsc', 503]]);
});

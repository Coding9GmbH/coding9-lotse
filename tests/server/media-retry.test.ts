import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

// Bildgenerierung (OpenAI) wiederholt 429/5xx begrenzt und beachtet Retry-After; 4xx sonst nie. Lokaler Fake statt api.openai.com.
process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-media-retry-'));
type Step = { status: number; headers?: Record<string, string>; body?: unknown };
let script: Step[] = [], calls = 0; const seen: { path: string; auth: string; body: string }[] = [];
const PNG = Buffer.from('png-bytes').toString('base64');
const server = http.createServer((req, res) => {
  let b = ''; req.on('data', c => (b += c));
  req.on('end', () => {
    seen.push({ path: req.url ?? '', auth: String(req.headers.authorization), body: b });
    const s = script[Math.min(calls++, script.length - 1)];
    res.writeHead(s.status, { 'content-type': 'application/json', ...s.headers }); res.end(JSON.stringify(s.body ?? { data: [{ b64_json: PNG }] }));
  });
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
process.env.LOTSE_OPENAI_API_BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`;
after(() => server.close());

const { generateRaster, setImageConfig } = await import('../../src/server/media');
setImageConfig({ key: 'sk-test', model: '' });
beforeEach(() => { calls = 0; seen.length = 0; });

test('generateRaster: 429 (Retry-After) und 502 werden wiederholt, Anfrage bleibt identisch', async () => {
  script = [{ status: 429, headers: { 'retry-after': '0' }, body: { error: { message: 'Rate limit' } } }, { status: 502, headers: { 'retry-after': '0' } }, { status: 200 }];
  assert.equal((await generateRaster('Eine Vase')).toString(), 'png-bytes');
  assert.equal(calls, 3);
  assert.ok(seen.every(s => s.path === '/v1/images/generations' && s.auth === 'Bearer sk-test' && s.body === seen[0].body));
  assert.equal(JSON.parse(seen[0].body).prompt, 'Eine Vase');
});

test('generateRaster: nach 3 Versuchen Schluss mit verständlicher Meldung', async () => {
  script = [{ status: 503, headers: { 'retry-after': '0' }, body: { error: { message: 'Überlastet' } } }];
  await assert.rejects(generateRaster('x'), /Bildgenerierung fehlgeschlagen \(503\): Überlastet/);
  assert.equal(calls, 3);
});

test('generateRaster: 400/401 werden nicht wiederholt', async () => {
  for (const status of [400, 401]) {
    calls = 0; script = [{ status, body: { error: { message: 'abgelehnt' } } }, { status: 200 }];
    await assert.rejects(generateRaster('x'), new RegExp(`\\(${status}\\): abgelehnt`));
    assert.equal(calls, 1, String(status));
  }
});

test('generateRaster: sehr langes Retry-After wird nicht abgewartet', async () => {
  script = [{ status: 429, headers: { 'retry-after': '3600' }, body: { error: { message: 'Limit' } } }, { status: 200 }];
  await assert.rejects(generateRaster('x'), /\(429\): Limit/);
  assert.equal(calls, 1);
});

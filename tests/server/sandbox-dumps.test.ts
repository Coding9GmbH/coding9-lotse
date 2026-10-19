import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { NextRequest } from 'next/server';
import '../isolate-data';
/* eslint-disable @typescript-eslint/no-explicit-any -- loose JSON bodies in assertions */

// Dump uploads: chunked assembly, offset/size/magic/checksum checks, traversal, file mode, sweeper; routes (403 off, chunk > 16 MB,
// x-lotse required by the proxy), never any content in a response.
for (const k of ['LOTSE_SANDBOX', 'LOTSE_PASSWORD', 'ALLOWED_HOSTS', 'HOSTNAME', 'HOST', 'AICB_DOCKER', 'LOTSE_BIND', 'LOTSE_SANDBOX_NETWORK', 'LOTSE_SANDBOX_SUBNET', 'LOTSE_SANDBOX_RUNNER', 'LOTSE_DUMP_MAX_MB']) delete process.env[k];
const D = await import('../../src/server/sandbox/dumps');
const E = await import('../../src/server/sandbox/env');
const db = await import('../../src/server/db');
const { FakeRunner } = await import('../../src/server/sandbox/fake-runner');
const { setRunner } = await import('../../src/server/sandbox/runner');
const R = await import('../../src/server/sandbox/reconcile');
const dumpsRoute = await import('../../src/app/api/sandbox/dumps/route');
const dumpRoute = await import('../../src/app/api/sandbox/dumps/[id]/route');
const completeRoute = await import('../../src/app/api/sandbox/dumps/[id]/complete/route');
const { proxy } = await import('../../src/proxy');
const fake = new FakeRunner();
setRunner(fake);
after(async () => { R.resetReconcile(); await fake.close(); });

const SQL = Buffer.from('-- MySQL dump 10.13\n/*!40101 SET NAMES utf8mb4 */;\nINSERT INTO `migration` VALUES (\'Shopware\\\\Core\\\\Migration\\\\V6_6\\\\Migration1700000000Foo\',1700000000,NULL,NULL,NULL),(\'Shopware\\\\Core\\\\Migration\\\\V6_5\\\\Migration1600000000Bar\',1,NULL,NULL,NULL);\nINSERT INTO `product` VALUES (1);\n');
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const stream = (b: Buffer) => Readable.from([b]);
async function upload(data: Buffer, name = 'shop.sql', chunk = 7) {
  const d = D.createDump(name, data.length);
  for (let o = 0; o < data.length; o += chunk) await D.appendChunk(d.id, o, stream(data.subarray(o, o + chunk)), { length: Math.min(chunk, data.length - o), sha256: sha(data.subarray(o, o + chunk)) });
  return D.completeDump(d.id, sha(data));
}
const status = async (p: Promise<unknown>) => { try { await p; return 0; } catch (e) { return (e as { status: number }).status; } };

test('chunked assembly: file identical, mode 0600 in a 0700 directory, sha256 recorded; metadata never holds content or a path', async () => {
  const d = await upload(SQL);
  const file = D.dumpFile(d.id);
  assert.deepEqual(fs.readFileSync(file), SQL);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(d.status, 'ready');
  assert.equal(d.sha256, sha(SQL));
  const pub = D.publicDump(d);
  assert.deepEqual(Object.keys(pub).sort(), ['expiresAt', 'id', 'library', 'name', 'received', 'sha256', 'size', 'status', 'taskId']);
  assert.ok(!JSON.stringify(pub).includes('MySQL') && !JSON.stringify(pub).includes(file));
  assert.equal(await D.dumpShopwareVersion(file), '6.6', 'newest core migration namespace');
  D.deleteDump(d.id);
  // Sequel Ace: # comments, one row per line after VALUES
  const ace = await upload(Buffer.from([
    '# Sequel Ace SQL dump', '', 'SET NAMES utf8mb4;', 'INSERT INTO `migration` (`class`, `creation_timestamp`)', 'VALUES',
    "\t('Shopware\\\\Core\\\\Migration\\\\V6_5\\\\Migration1',1),", "\t('Shopware\\\\Core\\\\Migration\\\\V6_7\\\\Migration2',2);", '',
    'INSERT INTO `product` (`id`)', 'VALUES', "\t('Shopware\\\\Core\\\\Migration\\\\V6_9\\\\NotAMigration');", '',
  ].join('\n')));
  assert.equal(ace.status, 'ready');
  assert.equal(await D.dumpShopwareVersion(D.dumpFile(ace.id)), '6.7', 'Sequel Ace: rows on their own lines, other tables ignored');
  D.deleteDump(ace.id);
  assert.ok(!fs.existsSync(path.dirname(file)));
  assert.equal(db.codeDumpGet(d.id)!.status, 'deleted');
});

test('wrong offset → 409 with the received count; failed chunk is cut back so the upload resumes', async () => {
  const d = D.createDump('a.sql', SQL.length);
  await D.appendChunk(d.id, 0, stream(SQL.subarray(0, 10)));
  await assert.rejects(D.appendChunk(d.id, 5, stream(SQL.subarray(5, 10))), (e: any) => e.status === 409 && e.extra.received === 10);
  assert.equal(await status(D.appendChunk(d.id, 10, stream(SQL.subarray(10, 20)), { sha256: 'a'.repeat(64) })), 422, 'chunk checksum');
  assert.equal(fs.statSync(D.dumpFile(d.id)).size, 10, 'cut back to the offset');
  await D.appendChunk(d.id, 10, stream(SQL.subarray(10)));
  assert.equal(await status(D.completeDump(d.id, 'b'.repeat(64))), 422, 'whole-file checksum');
  assert.equal(db.codeDumpGet(d.id)!.status, 'deleted', 'a dump with a wrong checksum is discarded');
});

test('size cap: declared size over LOTSE_DUMP_MAX_MB → 413; more bytes than declared are stopped mid-stream (413)', async () => {
  process.env.LOTSE_DUMP_MAX_MB = '1';
  assert.equal(await status(Promise.resolve().then(() => D.createDump('big.sql', 1024 * 1024 + 1))), 413);
  delete process.env.LOTSE_DUMP_MAX_MB;
  const d = D.createDump('small.sql', 100);
  async function* gen() { for (let i = 0; i < 10; i++) yield Buffer.alloc(30, 0x41); } // 300 bytes, no length announced
  assert.equal(await status(D.appendChunk(d.id, 0, Readable.from(gen()))), 413);
  assert.equal(fs.statSync(D.dumpFile(d.id)).size, 0);
  assert.equal(await status(D.appendChunk(d.id, 0, stream(Buffer.alloc(10)), { length: D.CHUNK_MAX + 1 })), 413, 'announced chunk over 16 MB');
  D.deleteDump(d.id);
});

test('magic: gzip and plain SQL pass, anything else → 415 and the file is gone', async () => {
  const gz = await upload(zlib.gzipSync(SQL), 'shop.sql.gz', 1000);
  assert.equal(gz.status, 'ready');
  assert.equal(await D.dumpShopwareVersion(D.dumpFile(gz.id)), '6.6', 'read through gzip');
  D.deleteDump(gz.id);
  for (const bad of [Buffer.from('PK\x03\x04zip'), Buffer.from('\x00\x01binary'), Buffer.from('<html>no</html>'), zlib.gzipSync(Buffer.from('#!/bin/sh\nrm -rf /'))]) {
    const d = D.createDump('x.sql', bad.length);
    await D.appendChunk(d.id, 0, stream(bad));
    assert.equal(await status(D.completeDump(d.id)), 415, bad.subarray(0, 6).toString('latin1'));
    assert.ok(!fs.existsSync(D.dumpFile(d.id)));
  }
  assert.ok(D.looksLikeSql(Buffer.from('/*M!999999\\- enable the sandbox mode */\n-- MariaDB dump')));
  assert.ok(D.looksLikeSql(Buffer.from('# ****\n# Sequel Ace SQL dump\n#\n\n\n/*!40101 SET NAMES utf8mb4 */;\nSET NAMES utf8mb4;\n')), 'Sequel Ace: # comments');
  assert.ok(!D.looksLikeSql(Buffer.from('# comment\n#!/bin/sh\nrm -rf /\n')), 'shebang after a comment');
  assert.ok(!D.looksLikeSql(Buffer.from('# just comments\n# nothing else\n')), 'comments only');
});

test('a dump that selects its own database (mysqldump --databases) is refused: 422, file gone', async () => {
  const head = '-- MySQL dump 10.13\n/*!40101 SET NAMES utf8mb4 */;\n';
  const variants = [
    `${head}CREATE DATABASE /*!32312 IF NOT EXISTS*/ \`shop_prod\` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;\n\nUSE \`shop_prod\`;\n${SQL.toString('latin1')}`,
    `${SQL.toString('latin1')}${'INSERT INTO `product` VALUES (1);\n'.repeat(5000)}use shop_prod;\n`, // late, lower case
  ];
  for (const [i, text] of variants.entries()) for (const data of [Buffer.from(text, 'latin1'), zlib.gzipSync(Buffer.from(text, 'latin1'))]) {
    const d = D.createDump('x.sql', data.length);
    await D.appendChunk(d.id, 0, stream(data));
    const err = await D.completeDump(d.id).then(() => null, e => e as { status: number; message: string });
    assert.equal(err?.status, 422, `variant ${i}`);
    assert.match(err!.message, /eigene Datenbank/);
    assert.ok(!fs.existsSync(D.dumpFile(d.id)));
  }
  // a value that merely contains "USE" or "CREATE DATABASE" is fine
  const ok = await upload(Buffer.from(`${SQL.toString('latin1')}INSERT INTO \`cms_slot\` VALUES ('USE \\nCREATE DATABASE x');\n`, 'latin1'));
  assert.equal(ok.status, 'ready');
  D.deleteDump(ok.id);
});

test('id and name traversal are refused', async () => {
  for (const name of ['../x.sql', 'a/b.sql', '..sql', 'x.sql/..', 'x.txt', '.sql', 'a\\b.sql', 'x.sql.gz.exe', '']) assert.equal(await status(Promise.resolve().then(() => D.createDump(name, 1))), 400, name);
  for (const id of ['../etc', 'd_../../aaaaaaaaa', 'd_AAAAAAAAAAAAAAAA', 'x']) {
    assert.throws(() => D.dumpFile(id), /Ungültige Dump-ID/);
    assert.equal(await status(D.appendChunk(id, 0, stream(Buffer.from('x')))), 400);
  }
  const outside = path.join(db.dataDir(), 'keep.txt'); fs.writeFileSync(outside, 'x');
  D.deleteDump('../keep.txt'); // ignored, nothing removed
  assert.ok(fs.existsSync(outside));
});

test('sweeper: expired, orphaned (task gone or done), leftover directories and rows without a file', async () => {
  const now = Date.now();
  const expired = D.createDump('old.sql', 3, now - D.DUMP_TTL_MS - 1000);
  const fresh = D.createDump('new.sql', 3, now);
  const ofDone = await upload(SQL, 'done.sql'); D.attachDump(ofDone.id, 't_done00000000');
  const ofGone = await upload(SQL, 'gone.sql'); D.attachDump(ofGone.id, 't_gone00000000');
  const ofLive = await upload(SQL, 'live.sql'); D.attachDump(ofLive.id, 't_live00000000');
  const noFile = D.createDump('nofile.sql', 3, now); fs.rmSync(path.dirname(D.dumpFile(noFile.id)), { recursive: true });
  const stray = path.join(db.dataDir(), 'dumps', 'd_strayxxxxxxxxxxx'); fs.mkdirSync(stray, { recursive: true }); fs.writeFileSync(path.join(stray, 'data'), 'x');
  const junk = path.join(db.dataDir(), 'dumps', 'not-a-dump'); fs.mkdirSync(junk);
  const status_ = (id: string) => ({ t_done00000000: 'done', t_live00000000: 'ready' } as Record<string, string>)[id] ?? null;
  const removed = D.sweepDumps(status_, now);
  for (const d of [expired, ofDone, ofGone, noFile]) { assert.ok(removed.includes(d.id), d.name); assert.equal(db.codeDumpGet(d.id)!.status, 'deleted'); }
  for (const d of [fresh, ofLive]) { assert.ok(!removed.includes(d.id), d.name); assert.ok(fs.existsSync(D.dumpFile(d.id))); }
  assert.ok(!fs.existsSync(stray) && !fs.existsSync(junk));
  assert.ok(!fs.existsSync(path.dirname(D.dumpFile(expired.id))));
  for (const d of [fresh, ofLive]) D.deleteDump(d.id);
});

test('startup sweep runs while Sandbox Coding is off: an expired dump is deleted', async () => {
  assert.equal(E.sandboxEnabled(), false);
  R.resetReconcile();
  const expired = D.createDump('old.sql', 3, Date.now() - D.DUMP_TTL_MS - 1000);
  await R.ensureReconciled();
  assert.equal(db.codeDumpGet(expired.id)!.status, 'deleted');
  assert.ok(!fs.existsSync(path.dirname(D.dumpFile(expired.id))));
  R.resetReconcile();
});

// ---- Routes ----
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const put = (id: string, offset: number | string, body: BodyInit, headers: Record<string, string> = {}) =>
  dumpRoute.PUT(new NextRequest(`http://127.0.0.1/api/sandbox/dumps/${id}?offset=${offset}`, { method: 'PUT', body, headers, duplex: 'half' } as any), ctx(id));
const create = (body: unknown) => dumpsRoute.POST(new Request('http://127.0.0.1/api/sandbox/dumps', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

test('routes: 403 while off; create, chunks, resume info, complete, delete; a chunk over 16 MB is refused', async () => {
  assert.equal((await create({ name: 'a.sql', size: 3 })).status, 403);
  E.saveSandbox({ enabled: true });
  const c = await create({ name: 'shop.sql', size: SQL.length });
  assert.equal(c.status, 201);
  const { dump } = await c.json() as any;
  assert.equal((await put(dump.id, 0, SQL.subarray(0, 20))).status, 200);
  const wrong = await put(dump.id, 0, SQL.subarray(0, 20));
  assert.equal(wrong.status, 409);
  assert.equal(((await wrong.json()) as any).received, 20);
  const meta = await (await dumpRoute.GET(new NextRequest(`http://127.0.0.1/api/sandbox/dumps/${dump.id}`), ctx(dump.id))).json() as any;
  assert.equal(meta.dump.received, 20);
  assert.ok(!JSON.stringify(meta).includes('MySQL'), 'never the content');
  assert.equal((await put(dump.id, 20, SQL.subarray(20), { 'x-chunk-sha256': sha(SQL.subarray(20)) })).status, 200);
  const done = await completeRoute.POST(new Request('http://127.0.0.1/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sha256: sha(SQL) }) }), ctx(dump.id));
  assert.equal(done.status, 200);
  assert.equal(((await done.json()) as any).dump.status, 'ready');
  assert.ok(db.auditList().some(a => (a as any).kind === 'sandbox-dump' && (a as any).action === 'upload' && !JSON.stringify(a).includes('MySQL')));
  assert.equal((await dumpRoute.DELETE(new NextRequest(`http://127.0.0.1/api/sandbox/dumps/${dump.id}`, { method: 'DELETE' }), ctx(dump.id))).status, 200);
  assert.ok(!fs.existsSync(D.dumpFile(dump.id)));

  const big = await (await create({ name: 'big.sql', size: 40 * 1024 * 1024 })).json() as any;
  assert.equal((await put(big.dump.id, 0, Buffer.alloc(D.CHUNK_MAX + 1, 0x2d))).status, 413);
  assert.equal(fs.statSync(D.dumpFile(big.dump.id)).size, 0);
  assert.equal((await put(big.dump.id, 'abc', Buffer.from('x'))).status, 400);
  assert.equal((await put('d_nonexistent00000', 0, Buffer.from('x'))).status, 404);
  D.deleteDump(big.dump.id);
  E.saveSandbox({ enabled: false });
});

test('proxy: a chunk upload without the UI marker (x-lotse) or from a foreign origin is refused', async () => {
  const req = (headers: Record<string, string>) => new NextRequest('http://localhost:3333/api/sandbox/dumps/d_aaaaaaaaaaaaaaaa?offset=0', { method: 'PUT', headers: { host: 'localhost:3333', ...headers }, body: 'x', duplex: 'half' } as any);
  assert.equal((await proxy(req({}))).status, 403);
  assert.equal((await proxy(req({ origin: 'null', 'x-lotse': '1' }))).status, 403);
  assert.equal((await proxy(req({ 'x-lotse': '1' }))).status, 200);
});

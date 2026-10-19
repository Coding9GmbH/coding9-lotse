import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import '../isolate-data';

// Streaming tar of one large file (dump import): ustar header fields, checksum, padding, exact length, size guard.
const { streamFileTar, streamTar, writeTar } = await import('../../src/server/sandbox/tar');
const { readTarEntries } = await import('../../src/server/sandbox/fake-runner');
const owner = { uid: 33, gid: 33, uname: 'www-data', gname: 'www-data', mtime: 1_700_000_000 };
const collect = async (r: Readable) => { const parts: Buffer[] = []; for await (const c of r) parts.push(c as Buffer); return Buffer.concat(parts); };

test('streamFileTar: directory + file headers in ustar format, data padded to 512, two zero blocks, exact announced length', async () => {
  const data = Buffer.alloc(1000, 0x61);
  const { stream, length } = streamFileTar('lotse-import', 'dump', data.length, Readable.from([data.subarray(0, 300), data.subarray(300)]), owner);
  const tar = await collect(stream);
  assert.equal(tar.length, length);
  assert.equal(length, 512 + 512 + 1024 + 1024);
  const h = tar.subarray(512, 1024);
  const field = (a: number, b: number) => h.subarray(a, b).toString('ascii').replace(/\0.*$/s, '');
  assert.equal(field(0, 100), 'lotse-import/dump');
  assert.equal(field(100, 108), '0000600');
  assert.equal(field(108, 116), '0000041'); // uid 33 octal
  assert.equal(field(124, 136), '00000001750'); // 1000 octal
  assert.equal(field(136, 148), (1_700_000_000).toString(8).padStart(11, '0'));
  assert.equal(String.fromCharCode(h[156]), '0');
  assert.equal(h.subarray(257, 263).toString('ascii'), 'ustar\0');
  assert.equal(field(265, 297), 'www-data');
  let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
  assert.equal(parseInt(field(148, 156).trim(), 8), sum, 'header checksum');
  assert.ok(tar.subarray(1024 + 1000).every(b => b === 0), 'padding and end blocks');
  assert.deepEqual(readTarEntries(tar).map(e => [e.path, e.type, e.mode, e.data.length]), [['lotse-import', 'dir', 0o700, 0], ['lotse-import/dump', 'file', 0o600, 1000]]);
  // same header layout as the buffered writer
  assert.deepEqual(tar.subarray(512, 1024), writeTar([{ path: 'lotse-import/dump', type: 'file', data, mode: 0o600 }], owner).subarray(0, 512));
});

test('streamFileTar: a file that is larger or smaller than announced fails the stream', async () => {
  await assert.rejects(collect(streamFileTar('d', 'dump', 4, Readable.from([Buffer.from('12345')]), owner).stream), /größer/);
  await assert.rejects(collect(streamFileTar('d', 'dump', 6, Readable.from([Buffer.from('12345')]), owner).stream), /kleiner/);
  assert.throws(() => streamFileTar('x'.repeat(100), 'dump', 1, Readable.from([]), owner), /zu lang/);
});

test('streamTar: byte-identical to writeTar (long paths, symlinks, lazy files), announced length exact, a file that changed size is refused', async () => {
  const long = `${'d'.repeat(90)}/${'e'.repeat(90)}/${'f'.repeat(60)}.txt`;
  const lazy = (path: string, text: string) => ({ path, type: 'file' as const, size: text.length, read: () => Buffer.from(text), mode: 0o644 });
  const entries = [{ path: 'a', type: 'dir' as const }, lazy('a/x.txt', 'hello'), lazy(long, 'x'.repeat(1000)), { path: 'a/l', type: 'symlink' as const, linkTarget: 'x.txt' }, { path: 'a/empty', type: 'file' as const, data: Buffer.alloc(0) }];
  const s = streamTar(entries, owner), got = await collect(s.stream);
  assert.equal(got.length, s.length);
  assert.ok(got.equals(writeTar(entries, owner)));
  assert.deepEqual(readTarEntries(got).filter(e => e.type === 'file').map(e => e.path), ['a/x.txt', long, 'a/empty']);
  await assert.rejects(collect(streamTar([{ path: 'g', type: 'file', size: 3, read: () => Buffer.from('four') }], owner).stream), /während der Übertragung geändert/);
});

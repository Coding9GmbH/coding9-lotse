import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('Satoshi liegt im Repo und --display nutzt die lokale Variable zuerst', () => {
  const layout = read('src/app/layout.tsx');
  assert.doesNotMatch(layout, /fontshare/i);
  assert.doesNotMatch(layout, /preconnect/);
  assert.match(layout, /variable:\s*'--font-satoshi'/);
  assert.match(layout, /satoshi-500\.woff2/);
  assert.match(layout, /satoshi-700\.woff2/);
  assert.match(layout, /weight:\s*'500'/);
  assert.match(layout, /weight:\s*'700'/);
  const css = read('src/app/globals.css');
  const display = css.match(/--display:\s*([^;]+);/);
  assert.ok(display, '--display fehlt');
  assert.match(display[1], /^\s*var\(--font-satoshi\)/);
  for (const file of ['src/app/fonts/satoshi-500.woff2', 'src/app/fonts/satoshi-700.woff2']) {
    const buf = readFileSync(new URL(`../../${file}`, import.meta.url));
    assert.ok(buf.length > 1000, `${file} ist zu klein`);
    assert.equal(buf.subarray(0, 4).toString('ascii'), 'wOF2', file);
  }
});

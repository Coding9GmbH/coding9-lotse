import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shopTimeoutMs } from '../../../../src/server/platform/shopify/client';

test('Shopify timeout: 60s, at least 5s, otherwise the configured value', () => {
  assert.equal(shopTimeoutMs(undefined), 60_000);
  assert.equal(shopTimeoutMs(''), 60_000);
  assert.equal(shopTimeoutMs('1000'), 5_000);
  assert.equal(shopTimeoutMs('120000'), 120_000);
});

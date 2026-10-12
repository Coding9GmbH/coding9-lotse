/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import type { FakeShopify } from './server';

export interface GqlBody {
  data?: any;
  errors?: any[];
  extensions?: any;
}

/** Runs a GraphQL request against the fake and returns the parsed body. */
export async function gql(fake: FakeShopify, query: string, variables?: Record<string, unknown>): Promise<GqlBody> {
  const res = await fake.graphql<GqlBody>(query, variables);
  assert.equal(res.status, 200, `unexpected HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

/** Like gql but asserts there are no top-level errors and returns data. */
export async function data(fake: FakeShopify, query: string, variables?: Record<string, unknown>): Promise<any> {
  const body = await gql(fake, query, variables);
  assert.equal(body.errors, undefined, `unexpected errors: ${JSON.stringify(body.errors, null, 2)}`);
  return body.data;
}

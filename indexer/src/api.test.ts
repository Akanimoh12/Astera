/**
 * #1174: unit coverage for `parsePaginationParams`, the input validation for
 * `/events`'s `limit`/`offset` query params. Pure function, no
 * Postgres/network dependency — run directly via ts-node (matches
 * parser.test.ts's style), no live services required.
 */
import assert from 'node:assert';
import { parsePaginationParams, MAX_EVENTS_LIMIT } from './api';

function expectOk(result: ReturnType<typeof parsePaginationParams>) {
  assert.strictEqual(result.ok, true, `expected ok, got error: ${JSON.stringify(result)}`);
  return (result as { ok: true; params: { limit: number; offset: number } }).params;
}

function expectError(result: ReturnType<typeof parsePaginationParams>) {
  assert.strictEqual(result.ok, false, `expected an error, got: ${JSON.stringify(result)}`);
}

function runTests() {
  console.log('[indexer api test] Running tests...');

  // Defaults when neither param is present.
  const defaults = expectOk(parsePaginationParams(undefined, undefined));
  assert.strictEqual(defaults.limit, 50);
  assert.strictEqual(defaults.offset, 0);

  // Well-formed values pass through.
  const ok = expectOk(parsePaginationParams('25', '10'));
  assert.strictEqual(ok.limit, 25);
  assert.strictEqual(ok.offset, 10);

  // limit at exactly the cap is allowed.
  const atCap = expectOk(parsePaginationParams(String(MAX_EVENTS_LIMIT), '0'));
  assert.strictEqual(atCap.limit, MAX_EVENTS_LIMIT);

  // limit beyond the cap is rejected — this is the "unbounded limit forces a
  // full table scan" half of the bug.
  expectError(parsePaginationParams(String(MAX_EVENTS_LIMIT + 1), '0'));
  expectError(parsePaginationParams('1000000', '0'));

  // limit of 0 or negative is rejected.
  expectError(parsePaginationParams('0', '0'));
  expectError(parsePaginationParams('-5', '0'));

  // Non-numeric limit/offset is rejected — this is the "parseInt(NaN)
  // silently reaches SQL" half of the bug. `parseInt` would have happily
  // (and wrongly) accepted "50abc" as 50 and "abc" as NaN.
  expectError(parsePaginationParams('abc', '0'));
  expectError(parsePaginationParams('50abc', '0'));
  expectError(parsePaginationParams('1e3', '0'));
  expectError(parsePaginationParams('3.5', '0'));
  expectError(parsePaginationParams(' 50', '0'));
  expectError(parsePaginationParams('50', 'abc'));
  expectError(parsePaginationParams('50', '-1'));

  // Array-shaped query values (e.g. `?limit=1&limit=2`) must be rejected,
  // not coerced — Express parses repeated query keys as string[].
  expectError(parsePaginationParams(['50', '60'], '0'));

  console.log('[indexer api test] All api tests passed!');
}

runTests();

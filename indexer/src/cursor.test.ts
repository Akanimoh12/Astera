/**
 * #1169: unit coverage for `ledgerToCursor`, the fix for the
 * lookback/reorg-rewind code passing a raw ledger sequence to
 * `horizon.effects().cursor()` instead of a proper Horizon TOID paging
 * token. Pure function, no Postgres/network dependency — run directly via
 * ts-node (matches parser.test.ts's style), no live services required.
 */
import assert from 'node:assert';
import { ledgerToCursor } from './cursor';

function runTests() {
  console.log('[indexer cursor test] Running tests...');

  // A bare ledger sequence like "12345" must never be returned verbatim —
  // that's exactly the #1169 bug (a raw sequence is orders of magnitude
  // smaller than any real TOID for that ledger, so passing it to Horizon's
  // `.cursor()` effectively rewinds to near the start of the whole chain).
  const raw = ledgerToCursor(12345);
  assert.notStrictEqual(raw, '12345', 'must not return the bare ledger sequence as the cursor');

  // The result must be the TOID for the *previous* ledger's last possible
  // operation, i.e. `(ledgerSeq << 32) - 1`, so `.cursor(result)` (which is
  // exclusive) resumes at the first operation of `ledgerSeq` itself.
  const expected = (12345n << 32n) - 1n;
  assert.strictEqual(ledgerToCursor(12345), expected.toString());

  // Monotonic: a later ledger must always produce a strictly larger cursor,
  // since Horizon's paging order is defined by numeric TOID comparison.
  const c1 = BigInt(ledgerToCursor(100));
  const c2 = BigInt(ledgerToCursor(101));
  assert.ok(c2 > c1, 'cursor must increase monotonically with ledger sequence');

  // Round-trip sanity: the ledger encoded in the cursor's high 32 bits must
  // be ledgerSeq - 1 (the previous ledger, since the cursor marks the very
  // end of it) — this is the actual TOID structure Horizon decodes.
  const cursor = BigInt(ledgerToCursor(500));
  const encodedLedger = cursor >> 32n;
  assert.strictEqual(encodedLedger, 499n);

  // Non-positive / zero ledger sequences clamp to "0" (Horizon's own
  // "from the very beginning" convention), rather than underflowing into a
  // negative or nonsensical cursor.
  assert.strictEqual(ledgerToCursor(0), '0');
  assert.strictEqual(ledgerToCursor(-5), '0');

  // A large, realistic ledger sequence must not lose precision to
  // floating-point bit-shift rounding (the reason this is computed in
  // BigInt rather than plain JS numbers).
  const large = 60_000_000; // comfortably past current mainnet ledger counts
  const largeCursor = BigInt(ledgerToCursor(large));
  assert.strictEqual(largeCursor, (BigInt(large) << 32n) - 1n);

  console.log('[indexer cursor test] All cursor tests passed!');
}

runTests();

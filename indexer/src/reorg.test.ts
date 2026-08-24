/**
 * #1175: integration test for reorg.ts's ledger-reorg detection/rollback,
 * which previously had no coverage at all. Requires a real Postgres
 * instance with migrations applied — mirrors db.test.ts's setup:
 *
 *   docker compose up -d indexer-postgres
 *   cd indexer && npm run migrate:up
 *   DATABASE_URL=postgres://astera:astera@localhost:5433/astera_indexer \
 *     ts-node src/reorg.test.ts
 *
 * `fetchLedgerMeta` is the one function here that talks to Horizon rather
 * than Postgres; it's exercised with a fake `Horizon.Server` (matching the
 * pattern in backfill.test.ts) so this file doesn't need a live Horizon
 * endpoint, only a database.
 */
import assert from 'node:assert';
import { Horizon } from 'stellar-sdk';
import { createPool, storeEvents } from './db';
import { detectReorg, fetchLedgerMeta, recordLedgerHash, rollbackFrom } from './reorg';
import { IndexedEvent } from './parser';

// Test-scoped ledger sequence range, chosen to be extremely unlikely to
// collide with any real indexed data (mirrors db.test.ts's `db-test-*` id
// prefixing convention, adapted for a numeric primary key).
const BASE_LEDGER = 987_650_000;

function testEvent(seq: number): IndexedEvent {
  return {
    id: `reorg-test-evt-${seq}`,
    contractId: 'CREORGTEST',
    contractType: 'invoice',
    eventType: 'created',
    topic: ['INVOICE', 'created'],
    value: [seq, 'GREORGTEST', '1000'],
    actor: 'GREORGTEST',
    ledgerSequence: seq,
    ledgerCloseAt: new Date().toISOString(),
    txHash: `reorg-test-tx-${seq}`,
    createdAt: new Date().toISOString(),
  };
}

function fakeHorizonLedgers(bySequence: Record<number, { hash: string; prev_hash: string } | 'error'>) {
  const builder = {
    ledger: (sequence: number) => ({
      call: async () => {
        const entry = bySequence[sequence];
        if (entry === undefined || entry === 'error') {
          throw new Error(`no fake ledger configured for ${sequence}`);
        }
        return { hash: entry.hash, prev_hash: entry.prev_hash };
      },
    }),
  };
  return { ledgers: () => builder } as unknown as Horizon.Server;
}

async function main() {
  console.log('[indexer reorg test] Running tests...');

  const pool = createPool();
  try {
    // --- fetchLedgerMeta -------------------------------------------------
    const okHorizon = fakeHorizonLedgers({
      [BASE_LEDGER]: { hash: 'HASH_A', prev_hash: 'HASH_PARENT' },
    });
    const meta = await fetchLedgerMeta(okHorizon, BASE_LEDGER);
    assert.ok(meta, 'expected ledger metadata for a ledger the fake Horizon knows about');
    assert.strictEqual(meta!.sequence, BASE_LEDGER);
    assert.strictEqual(meta!.hash, 'HASH_A');
    assert.strictEqual(meta!.prevHash, 'HASH_PARENT');

    const failingHorizon = fakeHorizonLedgers({});
    const missingMeta = await fetchLedgerMeta(failingHorizon, BASE_LEDGER + 1);
    assert.strictEqual(missingMeta, null, 'a Horizon fetch failure must resolve to null, not throw');

    // --- recordLedgerHash + detectReorg -----------------------------------
    await recordLedgerHash(pool, {
      sequence: BASE_LEDGER,
      hash: 'HASH_A',
      prevHash: 'HASH_PARENT',
    });

    // No hash recorded yet for BASE_LEDGER+1's predecessor (BASE_LEDGER+1
    // itself) — detectReorg must not flag anything it has no baseline for.
    const noBaseline = await detectReorg(pool, {
      sequence: BASE_LEDGER + 2,
      hash: 'HASH_C',
      prevHash: 'anything',
    });
    assert.strictEqual(noBaseline, false, 'must not flag a reorg when there is no recorded prior hash');

    // The canonical, no-reorg case: the next ledger's prev_hash matches what
    // was recorded for its parent.
    const noReorg = await detectReorg(pool, {
      sequence: BASE_LEDGER + 1,
      hash: 'HASH_B',
      prevHash: 'HASH_A',
    });
    assert.strictEqual(noReorg, false);

    // The actual reorg case: the next ledger's prev_hash does NOT match the
    // hash recorded for its parent — the chain reorganized underneath us.
    const reorgDetected = await detectReorg(pool, {
      sequence: BASE_LEDGER + 1,
      hash: 'HASH_B_FORKED',
      prevHash: 'HASH_A_WRONG',
    });
    assert.strictEqual(reorgDetected, true);

    // recordLedgerHash upserts — recording a different hash for the same
    // sequence must overwrite, not duplicate/error.
    await recordLedgerHash(pool, {
      sequence: BASE_LEDGER,
      hash: 'HASH_A_REVISED',
      prevHash: 'HASH_PARENT',
    });
    const { rows: revisedRows } = await pool.query(
      'SELECT ledger_hash FROM ledger_hashes WHERE ledger_sequence = $1',
      [BASE_LEDGER],
    );
    assert.strictEqual(revisedRows.length, 1, 'upsert must not create a duplicate row');
    assert.strictEqual(revisedRows[0].ledger_hash, 'HASH_A_REVISED');

    // --- rollbackFrom ------------------------------------------------------
    // Seed 3 consecutive "indexed" ledgers' worth of events + hash-chain
    // records, then roll back from the middle one.
    await storeEvents(pool, [
      testEvent(BASE_LEDGER + 10),
      testEvent(BASE_LEDGER + 11),
      testEvent(BASE_LEDGER + 12),
    ]);
    await recordLedgerHash(pool, { sequence: BASE_LEDGER + 10, hash: 'H10', prevHash: 'H9' });
    await recordLedgerHash(pool, { sequence: BASE_LEDGER + 11, hash: 'H11', prevHash: 'H10' });
    await recordLedgerHash(pool, { sequence: BASE_LEDGER + 12, hash: 'H12', prevHash: 'H11' });

    const removed = await rollbackFrom(pool, BASE_LEDGER + 11);
    assert.strictEqual(removed, 2, 'rollbackFrom(pool, N) must remove events at N and everything after');

    const { rows: remainingEvents } = await pool.query(
      'SELECT ledger_sequence FROM events WHERE ledger_sequence BETWEEN $1 AND $2 ORDER BY ledger_sequence',
      [BASE_LEDGER + 10, BASE_LEDGER + 12],
    );
    assert.deepStrictEqual(
      remainingEvents.map((r) => Number(r.ledger_sequence)),
      [BASE_LEDGER + 10],
      'only the ledger strictly before the rollback point may survive',
    );

    const { rows: remainingHashes } = await pool.query(
      'SELECT ledger_sequence FROM ledger_hashes WHERE ledger_sequence BETWEEN $1 AND $2 ORDER BY ledger_sequence',
      [BASE_LEDGER + 10, BASE_LEDGER + 12],
    );
    assert.deepStrictEqual(
      remainingHashes.map((r) => Number(r.ledger_sequence)),
      [BASE_LEDGER + 10],
      'the hash-chain record for the rolled-back range must also be removed',
    );

    const { rows: reorgLogRows } = await pool.query(
      'SELECT rolled_back_from, events_removed FROM reorg_log WHERE reorg_ledger = $1',
      [BASE_LEDGER + 11],
    );
    assert.strictEqual(reorgLogRows.length, 1, 'rollbackFrom must record an audit entry in reorg_log');
    assert.strictEqual(Number(reorgLogRows[0].rolled_back_from), BASE_LEDGER + 11);
    assert.strictEqual(reorgLogRows[0].events_removed, 2);

    // rollbackFrom on a range with nothing indexed must be a safe no-op —
    // this is the "backfill/reorg overlap with an already-empty range"
    // resume case.
    const removedEmpty = await rollbackFrom(pool, BASE_LEDGER + 999);
    assert.strictEqual(removedEmpty, 0);

    console.log('[indexer reorg test] All reorg tests passed!');
  } finally {
    await pool.query('DELETE FROM reorg_log WHERE reorg_ledger BETWEEN $1 AND $2', [
      BASE_LEDGER,
      BASE_LEDGER + 1000,
    ]);
    await pool.query('DELETE FROM ledger_hashes WHERE ledger_sequence BETWEEN $1 AND $2', [
      BASE_LEDGER,
      BASE_LEDGER + 1000,
    ]);
    await pool.query("DELETE FROM events WHERE id LIKE 'reorg-test-evt-%'");
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[indexer reorg test] FAILED:', err);
  process.exit(1);
});

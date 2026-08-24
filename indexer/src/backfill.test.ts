/**
 * #1175: coverage for backfill.ts's resume/crash behavior, which previously
 * had no tests at all. Uses a fake Horizon client (injected via
 * `runBackfill`'s optional third parameter — see backfill.ts) instead of a
 * live Horizon/testnet dependency, so this runs anywhere via plain ts-node,
 * no Postgres or network access required. `retryDelayMs`/`pageDelayMs` are
 * overridden to keep the crash-retry test fast.
 */
import assert from 'node:assert';
import { Horizon } from 'stellar-sdk';
import { runBackfill } from './backfill';
import { Pool } from 'pg';

// A contract id that never matches the filter passed to runBackfill in most
// of these tests, so the record still parses into an IndexedEvent that then
// gets filtered out by `contractIds.includes(...)` — this exercises the
// cursor-advancement/resume logic without ever reaching `storeEvents` (and
// therefore without needing a real Postgres pool). Test 2 below uses a
// matching contract id instead, specifically to exercise the branch where
// `currentLedger` *is* updated from a real indexed event before the
// `endLedger` check runs.
const UNMATCHED_CONTRACT = 'CUNMATCHED';
const MATCHED_CONTRACT = 'CMATCHED';

function effectRecord(ledgerSeq: number, contractId: string = UNMATCHED_CONTRACT) {
  return {
    type: 'contract',
    id: `evt-${ledgerSeq}`,
    paging_token: `${ledgerSeq}`,
    ledger_sequence: ledgerSeq,
    created_at: new Date().toISOString(),
    transaction_hash: `tx-${ledgerSeq}`,
    topic: ['INVOICE', 'created'],
    value: [1, 'GABCDEF', '1000'],
    contract: contractId,
  };
}

/**
 * Builds a fake `Horizon.Server` whose `.effects().cursor(c).order().limit().call()`
 * chain returns each of `pages` in order (repeating the last page forever),
 * throwing if the page function itself throws. Also records every cursor
 * value passed in, so tests can assert on the exact resume/progression
 * sequence.
 */
function fakeHorizon(pages: Array<() => Promise<{ records: any[] }>>) {
  const cursorsSeen: string[] = [];
  let callCount = 0;
  const builder: any = {
    cursor: (c: string) => {
      cursorsSeen.push(c);
      return builder;
    },
    order: () => builder,
    limit: () => builder,
    call: async () => {
      const page = pages[Math.min(callCount, pages.length - 1)];
      callCount++;
      return page();
    },
  };
  const horizon = { effects: () => builder } as unknown as Horizon.Server;
  return { horizon, cursorsSeen, callCount: () => callCount };
}

// storeEvents only runs `pool.query(...)` for a plain INSERT ... ON CONFLICT
// statement — stub it out rather than standing up a real Postgres instance,
// since these tests are about backfill's control flow (resume after error,
// endLedger stop condition, cursor dedup), not storage itself (already
// covered by db.test.ts against a real database).
const fakePool = { query: async () => ({ rowCount: 0, rows: [] }) } as unknown as Pool;

async function main() {
  console.log('[indexer backfill test] Running tests...');

  // Test 1: a transient Horizon error must not crash the whole backfill —
  // it should log, wait `retryDelayMs`, and resume on the next iteration.
  {
    let attempts = 0;
    const { horizon, callCount } = fakeHorizon([
      async () => {
        attempts++;
        throw new Error('simulated Horizon outage');
      },
      async () => {
        attempts++;
        return { records: [effectRecord(101), effectRecord(102)] };
      },
      async () => {
        attempts++;
        return { records: [] }; // complete
      },
    ]);

    await runBackfill(
      fakePool,
      {
        horizonUrl: 'http://fake-horizon.invalid',
        contractIds: [UNMATCHED_CONTRACT + '_NO_MATCH'],
        startLedger: 100,
        endLedger: null,
        retryDelayMs: 10,
        pageDelayMs: 1,
      },
      horizon,
    );

    assert.strictEqual(attempts, 3, 'expected exactly 3 Horizon calls: 1 failure + 2 successes');
    assert.strictEqual(callCount(), 3);
  }

  // Test 2: `endLedger` is respected as a hard stop — once a *matching,
  // indexed* event advances `currentLedger` to/past it, the loop must not
  // make another Horizon call. (currentLedger only advances from the raw
  // page's `ledger_sequence` — see Test 3 — when nothing in the page
  // actually matched `contractIds`; here it advances from the indexed
  // event itself, which is the realistic backfill-of-a-real-contract case.)
  {
    const { horizon, callCount } = fakeHorizon([
      async () => ({ records: [effectRecord(200, MATCHED_CONTRACT)] }),
    ]);

    await runBackfill(
      fakePool,
      {
        horizonUrl: 'http://fake-horizon.invalid',
        contractIds: [MATCHED_CONTRACT],
        startLedger: 150,
        endLedger: 200,
        retryDelayMs: 10,
        pageDelayMs: 1,
      },
      horizon,
    );

    assert.strictEqual(callCount(), 1, 'must stop immediately once currentLedger reaches endLedger');
  }

  // Test 3: a page that reports no forward progress (lastRecord's ledger
  // equals the current cursor) must still advance by one ledger rather than
  // looping forever on the same cursor.
  {
    const { horizon, cursorsSeen, callCount } = fakeHorizon([
      async () => ({ records: [effectRecord(300)] }), // no progress: == startLedger
      async () => ({ records: [] }), // complete
    ]);

    await runBackfill(
      fakePool,
      {
        horizonUrl: 'http://fake-horizon.invalid',
        contractIds: [UNMATCHED_CONTRACT + '_NO_MATCH'],
        startLedger: 300,
        endLedger: null,
        retryDelayMs: 10,
        pageDelayMs: 1,
      },
      horizon,
    );

    assert.strictEqual(callCount(), 2);
    assert.strictEqual(cursorsSeen[0], '300', 'first call must use the configured startLedger as cursor');
    assert.strictEqual(
      cursorsSeen[1],
      '301',
      'a page with no forward progress must advance the cursor by exactly one ledger',
    );
  }

  console.log('[indexer backfill test] All backfill tests passed!');
}

main().catch((err) => {
  console.error('[indexer backfill test] FAILED:', err);
  process.exit(1);
});

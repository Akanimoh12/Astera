/**
 * #1173: persisted resume checkpoint for backfill runs.
 *
 * Backfill progress was previously tracked only in-memory (plus a
 * Prometheus gauge for observability) — nothing was read back on startup,
 * so a crashed or restarted backfill process always started over from the
 * original `--backfill <from>` argument, re-walking ledgers it had already
 * indexed (harmless thanks to `storeEvents`' ON CONFLICT DO NOTHING, but
 * slow and wasteful for a large range).
 *
 * `job_key` identifies a backfill run by its watched contract set and
 * original starting ledger, so re-running the same `--backfill <from>`
 * command resumes from `current_ledger` instead of `start_ledger`, while a
 * genuinely different backfill (different contracts and/or a different
 * starting point) gets its own row instead of clobbering an in-flight one.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS backfill_checkpoints (
      job_key TEXT PRIMARY KEY,
      start_ledger BIGINT NOT NULL,
      end_ledger BIGINT,
      current_ledger BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS backfill_checkpoints;`);
};

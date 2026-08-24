/**
 * #1169: Horizon's `.cursor()` on the effects collection (and most other
 * Horizon collections) expects a "paging token" — a TOID encoding
 * `(ledgerSeq << 32) | (txOrder << 12) | opOrder` — NOT a bare ledger
 * sequence number. Passing a raw ledger sequence like "12345" as the cursor
 * is several orders of magnitude smaller than the TOID Horizon actually
 * compares paging tokens against for that same ledger, so code that set
 * `cursor = ledgerSeq.toString()` (the startup lookback window and the
 * reorg-rewind rollback point, both in index.ts's poll loop) was effectively
 * resuming from far earlier in Horizon's paging order than intended —
 * silently re-scanning enormous amounts of history instead of resuming
 * tightly at the intended ledger.
 */

/**
 * Builds the Horizon paging-token cursor that resumes exactly at the first
 * operation of `ledgerSeq` (inclusive) — i.e. the TOID for the last possible
 * operation of `ledgerSeq - 1` (txOrder/opOrder maxed out within the low 32
 * bits), since `.cursor(token)` returns records strictly *after* `token`.
 *
 * `ledgerSeq <= 0` clamps to the very start of the ledger stream ("0"),
 * matching Horizon's own convention of an empty-string/zero cursor meaning
 * "from the beginning".
 */
export function ledgerToCursor(ledgerSeq: number): string {
  const seq = Math.max(0, Math.trunc(ledgerSeq));
  if (seq === 0) return "0";
  // (seq << 32) - 1, computed in BigInt to avoid 32-bit overflow/precision
  // loss — a real ledger sequence exceeds JS's safe bit-shift range well
  // before mainnet does.
  const toid = (BigInt(seq) << 32n) - 1n;
  return toid.toString();
}

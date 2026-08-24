import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Horizon, xdr, scValToNative } from '@stellar/stellar-sdk';
import { OracleConfig } from './types';
import { Verifier } from './verifier';
import { ConsensusTracker } from './consensus';
import { StakingMetricsTracker } from './staking';

// #1176: reconnect backoff for the Horizon effect stream.
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_BACKOFF_MULTIPLIER = 2;

export class Listener {
  private config: OracleConfig;
  private verifier: Verifier;
  private horizon: Horizon.Server;
  private consensusTracker?: ConsensusTracker;
  private stakingTracker?: StakingMetricsTracker;
  public processedCount = 0;
  // #1176: bumped on every (re)connect so a stale reconnect timer from a
  // superseded stream can no longer schedule a second, duplicate connection.
  private streamGeneration = 0;
  private reconnectAttempts = 0;
  private closeStream?: () => void;
  private stopped = false;

  constructor(
    config: OracleConfig,
    verifier: Verifier,
    consensusTracker?: ConsensusTracker,
    stakingTracker?: StakingMetricsTracker,
  ) {
    this.config = config;
    this.verifier = verifier;
    this.consensusTracker = consensusTracker;
    this.stakingTracker = stakingTracker;
    this.horizon = new Horizon.Server(config.horizonUrl);
  }

  async start() {
    console.log(`[Listener] Starting event listener...`);
    console.log(`[Listener] Horizon: ${this.config.horizonUrl}`);
    console.log(`[Listener] Invoice contract: ${this.config.invoiceContractId}`);
    if (this.config.oracleRegistryContractId) {
      console.log(`[Listener] Oracle registry contract: ${this.config.oracleRegistryContractId}`);
    }

    // #980: resume from the last successfully processed ledger position
    // instead of always starting from 'now', so a restart neither misses
    // events that occurred while the service was down nor resubmits
    // already-processed votes by guessing at a lookback window.
    const cursor = this.loadCursor();
    this.connect(cursor);
  }

  /** Stop the listener and cancel any pending reconnect. */
  stop() {
    this.stopped = true;
    this.streamGeneration += 1;
    this.closeStream?.();
    this.closeStream = undefined;
  }

  /**
   * #1176: opens the Horizon effect stream. Previously `onerror` only
   * logged — a dropped SSE connection (network blip, Horizon restart, etc.)
   * silently stopped delivering new events forever while `/health` kept
   * reporting "up". Now `onerror` tears down the stream and reconnects with
   * exponential backoff (capped, with the attempt counter reset on the next
   * successful message), resuming from the last persisted cursor so no
   * events are missed or double-processed across the reconnect.
   */
  private connect(cursor: string) {
    const generation = ++this.streamGeneration;
    console.log(`[Listener] Starting stream from cursor: ${cursor}`);

    this.closeStream = this.horizon.effects()
      .cursor(cursor)
      .stream({
        onmessage: (effect: any) => {
          if (generation !== this.streamGeneration) return;
          this.reconnectAttempts = 0;
          this.handleEffect(effect);
          if (effect.paging_token) {
            this.saveCursor(effect.paging_token);
          }
        },
        onerror: (error: any) => {
          if (generation !== this.streamGeneration) return;
          console.error('[Listener] Stream error:', error);
          this.scheduleReconnect(generation);
        },
      });
  }

  private scheduleReconnect(generation: number) {
    if (this.stopped) return;
    // A newer stream has already superseded this one (e.g. stop() was
    // called and a fresh connect() started) — don't also reconnect this one.
    if (generation !== this.streamGeneration) return;

    this.closeStream?.();
    this.closeStream = undefined;

    this.reconnectAttempts += 1;
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(RECONNECT_BACKOFF_MULTIPLIER, this.reconnectAttempts - 1),
      RECONNECT_MAX_DELAY_MS,
    );
    console.log(
      `[Listener] Reconnecting to Horizon effect stream in ${delay}ms (attempt ${this.reconnectAttempts})`,
    );

    setTimeout(() => {
      if (this.stopped || generation !== this.streamGeneration) return;
      // Resume from the last persisted cursor (rather than the cursor this
      // particular stream started from), in case more effects were saved
      // during the connection's lifetime.
      this.connect(this.loadCursor());
    }, delay);
  }

  private loadCursor(): string {
    try {
      const saved = fs.readFileSync(this.config.listenerCursorPath, 'utf-8').trim();
      if (saved) {
        return saved;
      }
    } catch {
      // No checkpoint file yet (first run, or it was deleted) — start fresh.
    }
    return 'now';
  }

  /**
   * #1177: durably persist the stream cursor without risking a corrupted or
   * partially-written file if the process crashes mid-write. The previous
   * implementation did a direct `writeFileSync` to the target path on every
   * single effect — a crash between the OS truncating the file and finishing
   * the write left a truncated/corrupt cursor file, and even on a clean
   * write, every effect took an extra synchronous fsync-adjacent hit on the
   * hot path. Instead, write to a temp file in the same directory (so the
   * rename below stays on one filesystem) and atomically rename it over the
   * real cursor path — `rename` is atomic on POSIX and on Windows (NTFS), so
   * a reader/restart always sees either the old cursor or the new one, never
   * a partial file.
   */
  private saveCursor(pagingToken: string): void {
    const target = this.config.listenerCursorPath;
    const dir = path.dirname(target);
    const tmp = path.join(
      dir,
      `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
    );
    try {
      fs.writeFileSync(tmp, pagingToken, 'utf-8');
      fs.renameSync(tmp, target);
    } catch (error) {
      console.error('[Listener] Failed to persist stream cursor:', error);
      try {
        fs.unlinkSync(tmp);
      } catch {
        // best-effort cleanup of the temp file
      }
    }
  }

  private handleEffect(effect: any) {
    // Check if it's a contract event
    if (effect.type !== 'contract_event' && effect.type !== 'contract') {
      return;
    }

    try {
      const isInvoiceContract = effect.contract_id === this.config.invoiceContractId;
      const isRegistryContract =
        !!this.config.oracleRegistryContractId &&
        effect.contract_id === this.config.oracleRegistryContractId;

      // Filter by contract ID if present on the effect — accept either the
      // invoice contract (legacy `created` events) or, if configured, the
      // #861 oracle registry (round-status events for `ConsensusTracker`).
      if (effect.contract_id && !isInvoiceContract && !isRegistryContract) {
        return;
      }

      this.processedCount += 1;

      // Horizon effects for Soroban events typically have the topic and value
      // This part depends on how Horizon represents contract events in effects.
      // Based on the indexer implementation:
      const topicXdr = effect.topic;
      const valueXdr = effect.value;

      if (!topicXdr || !Array.isArray(topicXdr) || topicXdr.length < 2) {
        return;
      }

      // Topics are usually base64-encoded ScVal XDR
      const segment1 = this.decodeScVal(topicXdr[0]);
      const segment2 = this.decodeScVal(topicXdr[1]);

      console.log(`[Listener] Detected event: [${segment1}, ${segment2}]`);

      if (segment1 === 'INVOICE' && segment2 === 'created') {
        const value = this.decodeScVal(valueXdr);
        // The 'created' event payload is (id, owner, amount, metadata_uri)
        if (Array.isArray(value)) {
          const invoiceId = BigInt(value[0]);
          console.log(`[Listener] New invoice detected! ID: ${invoiceId}`);
          this.verifier.verifyInvoice(invoiceId);
        }
        return;
      }

      // #861: forward every event under the registry's "ORACLE" topic
      // namespace to the consensus tracker so the health endpoint can report
      // live round state without a separate polling loop.
      if (segment1 === 'ORACLE') {
        const value = this.decodeScVal(valueXdr);
        this.consensusTracker?.handleEvent(segment2, value);
        // #979: also forward to the staking metrics tracker, which filters
        // for `slashed` events concerning this node's own oracle address.
        this.stakingTracker?.handleEvent(segment2, value, effect.created_at);
      }
    } catch (error) {
      console.error('[Listener] Failed to process effect:', error);
    }
  }

  private decodeScVal(base64Xdr: string): any {
    try {
      const val = xdr.ScVal.fromXDR(base64Xdr, 'base64');
      return scValToNative(val);
    } catch {
      return null;
    }
  }
}

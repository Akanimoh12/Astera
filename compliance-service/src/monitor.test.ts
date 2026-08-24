/**
 * #1187: unit tests for the Monitor's structuring / rapid-cycle threshold
 * heuristics (#867).
 *
 * `complianceContractId` is left empty in every test config so
 * `flag()` -> `requestReviewOnChain()` returns immediately without touching
 * the network (see monitor.ts: `if (!this.config.complianceContractId) return;`),
 * keeping this suite offline.
 *
 * Run with: npx tsx --test src/monitor.test.ts
 * (or `npm test` from this package, see package.json)
 */
import assert from 'node:assert';
import { test, describe } from 'node:test';
import { Keypair } from '@stellar/stellar-sdk';
import { Monitor } from './monitor';
import type { ComplianceConfig } from './types';

function testConfig(overrides: Partial<ComplianceConfig> = {}): ComplianceConfig {
  return {
    rpcUrl: 'http://localhost:8000/soroban/rpc',
    horizonUrl: 'http://localhost:8000',
    networkPassphrase: 'Test SDF Network ; September 2015',
    screenerSecretKey: Keypair.random().secret(),
    // Empty on purpose: flag()'s on-chain call short-circuits when unset,
    // so tests never hit the network.
    complianceContractId: '',
    poolContractId: '',
    invoiceContractId: '',
    healthPort: 0,
    adminToken: '',
    structuringThreshold: 1000n,
    structuringWindowMs: 60_000,
    structuringMaxCount: 3,
    screeningProviderUrl: '',
    screeningProviderApiKey: '',
    screeningProviderTimeoutMs: 5000,
    rescreenCheckIntervalMs: 3_600_000,
    ...overrides,
  };
}

const ADDR = 'GSTRUCTURINGTESTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

describe('Monitor structuring heuristic', () => {
  test('does not flag when the count of sub-threshold deposits is below structuringMaxCount', async () => {
    const monitor = new Monitor(testConfig({ structuringMaxCount: 3 }));
    await monitor.recordDeposit(ADDR, 500n);
    await monitor.recordDeposit(ADDR, 500n);
    const alerts = monitor.listAlerts().filter((a) => a.pattern === 'structuring');
    assert.strictEqual(alerts.length, 0);
  });

  test('flags once the count of sub-threshold deposits reaches structuringMaxCount', async () => {
    const monitor = new Monitor(testConfig({ structuringMaxCount: 3, structuringThreshold: 1000n }));
    await monitor.recordDeposit(ADDR, 500n);
    await monitor.recordDeposit(ADDR, 500n);
    await monitor.recordDeposit(ADDR, 500n);
    const alerts = monitor.listAlerts().filter((a) => a.pattern === 'structuring');
    assert.strictEqual(alerts.length, 1);
    assert.match(alerts[0].reason, /structuring: 3 sub-threshold deposits/);
    assert.strictEqual(alerts[0].address, ADDR);
  });

  test('boundary: a deposit exactly equal to the threshold does not count as sub-threshold', async () => {
    const monitor = new Monitor(testConfig({ structuringMaxCount: 3, structuringThreshold: 1000n }));
    await monitor.recordDeposit(ADDR, 1000n);
    await monitor.recordDeposit(ADDR, 1000n);
    await monitor.recordDeposit(ADDR, 1000n);
    const alerts = monitor.listAlerts().filter((a) => a.pattern === 'structuring');
    assert.strictEqual(alerts.length, 0, 'amounts at (not under) the threshold must not count');
  });

  test('boundary: one unit under the threshold counts as sub-threshold', async () => {
    const monitor = new Monitor(testConfig({ structuringMaxCount: 3, structuringThreshold: 1000n }));
    await monitor.recordDeposit(ADDR, 999n);
    await monitor.recordDeposit(ADDR, 999n);
    await monitor.recordDeposit(ADDR, 999n);
    const alerts = monitor.listAlerts().filter((a) => a.pattern === 'structuring');
    assert.strictEqual(alerts.length, 1);
  });

  test('a zero-amount deposit never counts toward structuring (amount > 0n is required)', async () => {
    const monitor = new Monitor(testConfig({ structuringMaxCount: 3, structuringThreshold: 1000n }));
    await monitor.recordDeposit(ADDR, 0n);
    await monitor.recordDeposit(ADDR, 0n);
    await monitor.recordDeposit(ADDR, 0n);
    const alerts = monitor.listAlerts().filter((a) => a.pattern === 'structuring');
    assert.strictEqual(alerts.length, 0);
  });

  test('deposits older than structuringWindowMs age out and do not contribute to the count', async () => {
    const monitor = new Monitor(
      testConfig({ structuringMaxCount: 3, structuringThreshold: 1000n, structuringWindowMs: 30 }),
    );
    await monitor.recordDeposit(ADDR, 500n);
    await monitor.recordDeposit(ADDR, 500n);
    // Let the first two ticks age out of the 30ms window before the third.
    await new Promise((r) => setTimeout(r, 60));
    await monitor.recordDeposit(ADDR, 500n);
    const alerts = monitor.listAlerts().filter((a) => a.pattern === 'structuring');
    assert.strictEqual(alerts.length, 0, 'only 1 of 3 deposits is still within the window');
  });

  test('resets its tracked ticks after flagging, so the next sub-threshold deposit alone does not re-trigger', async () => {
    const monitor = new Monitor(testConfig({ structuringMaxCount: 3, structuringThreshold: 1000n }));
    await monitor.recordDeposit(ADDR, 500n);
    await monitor.recordDeposit(ADDR, 500n);
    await monitor.recordDeposit(ADDR, 500n);
    assert.strictEqual(monitor.listAlerts().filter((a) => a.pattern === 'structuring').length, 1);

    await monitor.recordDeposit(ADDR, 500n);
    assert.strictEqual(
      monitor.listAlerts().filter((a) => a.pattern === 'structuring').length,
      1,
      'a single deposit right after a reset must not immediately re-flag',
    );
  });

  test('tracks structuring independently per address', async () => {
    const monitor = new Monitor(testConfig({ structuringMaxCount: 3, structuringThreshold: 1000n }));
    const OTHER = 'GOTHERADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    await monitor.recordDeposit(ADDR, 500n);
    await monitor.recordDeposit(ADDR, 500n);
    await monitor.recordDeposit(OTHER, 500n);
    await monitor.recordDeposit(OTHER, 500n);
    assert.strictEqual(monitor.listAlerts().filter((a) => a.pattern === 'structuring').length, 0);
  });
});

describe('Monitor rapid-cycle heuristic', () => {
  test('does not flag a withdraw with no prior recorded deposit', async () => {
    const monitor = new Monitor(testConfig());
    const FRESH = 'GNODEPOSITXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    await monitor.recordWithdraw(FRESH, 100n);
    const alerts = monitor.listAlerts().filter((a) => a.pattern === 'rapid_cycle');
    assert.strictEqual(alerts.length, 0);
  });

  test('flags a withdraw that follows a deposit within 60s', async () => {
    const monitor = new Monitor(testConfig());
    await monitor.recordDeposit(ADDR, 100n);
    await monitor.recordWithdraw(ADDR, 100n);
    const alerts = monitor.listAlerts().filter((a) => a.pattern === 'rapid_cycle');
    assert.strictEqual(alerts.length, 1);
    assert.match(alerts[0].reason, /rapid deposit-then-withdraw within 60s/);
  });

  test('a deposit-then-withdraw pair below the structuring count does not also spuriously double-flag structuring', async () => {
    const monitor = new Monitor(testConfig({ structuringMaxCount: 5, structuringThreshold: 1000n }));
    await monitor.recordDeposit(ADDR, 100n);
    await monitor.recordWithdraw(ADDR, 100n);
    assert.strictEqual(monitor.listAlerts().filter((a) => a.pattern === 'structuring').length, 0);
    assert.strictEqual(monitor.listAlerts().filter((a) => a.pattern === 'rapid_cycle').length, 1);
  });
});

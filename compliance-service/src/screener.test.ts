/**
 * #1187: unit tests for the screener providers (#867 / #981).
 *
 * `MockScreener` is exercised directly — no network. `HttpScreenerProvider`
 * is exercised against a fake `fetch`, plus its timeout behavior, so the
 * suite runs offline and in CI without a real upstream KYC provider.
 *
 * Run with: npx tsx --test src/screener.test.ts
 * (or `npm test` from this package, see package.json)
 */
import assert from 'node:assert';
import { test, describe, beforeEach, afterEach } from 'node:test';
import { MockScreener, HttpScreenerProvider, SANCTIONS_FIXTURE } from './screener';

describe('MockScreener', () => {
  const screener = new MockScreener();

  test('blocks an address that exactly matches the sanctions fixture', async () => {
    const hit = SANCTIONS_FIXTURE.find((e) => !e.id.startsWith('G'))!;
    const result = await screener.screen(hit.id);
    assert.strictEqual(result.status, 'Blocked');
    assert.strictEqual(result.reasonCode, 9001);
    assert.strictEqual(result.riskTier, 'High');
    assert.strictEqual(result.matchedList, 'OFAC-SDN-fixture');
  });

  test('match is case-insensitive', async () => {
    const hit = SANCTIONS_FIXTURE.find((e) => !e.id.startsWith('G'))!;
    const result = await screener.screen(hit.id.toLowerCase());
    assert.strictEqual(result.status, 'Blocked');
  });

  test('blocks an address whose prefix matches a fixture G-address stub', async () => {
    const gEntry = SANCTIONS_FIXTURE.find((e) => e.id.startsWith('G'))!;
    // Same 8-char prefix as the fixture stub, different tail.
    const prefixed = gEntry.id.slice(0, 8) + 'DIFFERENTTAILXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    const result = await screener.screen(prefixed);
    assert.strictEqual(result.status, 'Blocked');
    assert.strictEqual(result.matchedList, gEntry.id);
  });

  test('a runtime-blocked address is blocked even though it is not in the bundled fixture', async () => {
    const s = new MockScreener();
    const addr = 'GRUNTIMEBLOCKEDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    assert.strictEqual((await s.screen(addr)).status, 'Cleared');
    s.addRuntimeBlock(addr);
    const result = await s.screen(addr);
    assert.strictEqual(result.status, 'Blocked');
    assert.strictEqual(result.reasonCode, 9001);
  });

  test('a clean address with no context clears', async () => {
    const result = await screener.screen('GCLEANADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');
    assert.strictEqual(result.status, 'Cleared');
    assert.strictEqual(result.reasonCode, 0);
    assert.strictEqual(result.riskTier, 'Low');
  });

  describe('high-risk jurisdiction', () => {
    test('flags a known high-risk jurisdiction', async () => {
      const result = await screener.screen('GJURISDICTIONXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', {
        jurisdiction: 'XX',
      });
      assert.strictEqual(result.status, 'Flagged');
      assert.strictEqual(result.reasonCode, 2001);
      assert.strictEqual(result.riskTier, 'High');
    });

    test('jurisdiction check is case-insensitive', async () => {
      const result = await screener.screen('GJURISDICTION2XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', {
        jurisdiction: 'xx',
      });
      assert.strictEqual(result.status, 'Flagged');
    });

    test('an unlisted jurisdiction does not flag', async () => {
      const result = await screener.screen('GJURISDICTION3XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', {
        jurisdiction: 'US',
      });
      assert.strictEqual(result.status, 'Cleared');
    });
  });

  describe('high-volume threshold (boundary at 1_000_000_000n)', () => {
    test('volume exactly at the threshold does not flag', async () => {
      const result = await screener.screen('GVOLUMEBOUNDARYXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', {
        recentVolume: 1_000_000_000n,
      });
      assert.strictEqual(result.status, 'Cleared');
      assert.strictEqual(result.riskTier, 'Low');
    });

    test('volume one unit above the threshold flags as Medium/Flagged', async () => {
      const result = await screener.screen('GVOLUMEOVERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', {
        recentVolume: 1_000_000_001n,
      });
      assert.strictEqual(result.status, 'Flagged');
      assert.strictEqual(result.reasonCode, 2002);
      assert.strictEqual(result.riskTier, 'Medium');
    });
  });

  describe('debtor concentration threshold (boundary at 5000 bps)', () => {
    test('concentration exactly at 5000 bps does not flag', async () => {
      const result = await screener.screen('GCONCBOUNDARYXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', {
        debtorConcentrationBps: 5000,
      });
      assert.strictEqual(result.status, 'Cleared');
      assert.strictEqual(result.riskTier, 'Low');
    });

    test('concentration one bp above 5000 flags as High/Flagged', async () => {
      const result = await screener.screen('GCONCOVERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', {
        debtorConcentrationBps: 5001,
      });
      assert.strictEqual(result.status, 'Flagged');
      assert.strictEqual(result.reasonCode, 2003);
      assert.strictEqual(result.riskTier, 'High');
    });
  });

  test('a sanctions hit takes priority even when other risk context is present', async () => {
    const hit = SANCTIONS_FIXTURE.find((e) => !e.id.startsWith('G'))!;
    const result = await screener.screen(hit.id, {
      jurisdiction: 'US',
      recentVolume: 0n,
      debtorConcentrationBps: 0,
    });
    assert.strictEqual(result.status, 'Blocked');
    assert.strictEqual(result.reasonCode, 9001);
  });

  test('high-risk jurisdiction plus high volume: first-set status wins, but risk tier still escalates', async () => {
    const result = await screener.screen('GMULTIRISKXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', {
      jurisdiction: 'ZZ',
      recentVolume: 2_000_000_000n,
    });
    assert.strictEqual(result.status, 'Flagged');
    // Jurisdiction check runs first and already set status to Flagged, so the
    // volume check's own reasonCode assignment is skipped — reasonCode stays
    // at the jurisdiction reason.
    assert.strictEqual(result.reasonCode, 2001);
    assert.strictEqual(result.riskTier, 'High');
  });
});

describe('HttpScreenerProvider', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('posts to <baseUrl>/screen and returns the parsed result', async () => {
    let calledUrl: string | undefined;
    let calledInit: RequestInit | undefined;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calledUrl = url;
      calledInit = init;
      return {
        ok: true,
        json: async () => ({
          address: 'GADDR',
          status: 'Cleared',
          reasonCode: 0,
          riskTier: 'Low',
          notes: 'ok',
        }),
      } as Response;
    }) as typeof fetch;

    const provider = new HttpScreenerProvider('https://provider.example/', 5000, 'secret-key');
    const result = await provider.screen('GADDR', { recentVolume: 42n });

    assert.strictEqual(calledUrl, 'https://provider.example/screen');
    assert.strictEqual(result.status, 'Cleared');
    const body = JSON.parse(String(calledInit?.body));
    assert.strictEqual(body.address, 'GADDR');
    // bigint is serialized as a string, since JSON.stringify can't handle bigint directly.
    assert.strictEqual(body.recentVolume, '42');
    assert.strictEqual((calledInit?.headers as Record<string, string>).Authorization, 'Bearer secret-key');
  });

  test('throws when the upstream responds with a non-OK status', async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 503 }) as Response) as typeof fetch;
    const provider = new HttpScreenerProvider('https://provider.example');
    await assert.rejects(
      () => provider.screen('GADDR'),
      /upstream screening provider returned 503/,
    );
  });

  test('throws a timeout-specific error when the upstream hangs past timeoutMs', async () => {
    globalThis.fetch = ((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }) as typeof fetch;

    const provider = new HttpScreenerProvider('https://provider.example', 10);
    await assert.rejects(
      () => provider.screen('GADDR'),
      /upstream screening provider timed out after 10ms/,
    );
  });
});

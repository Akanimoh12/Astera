import { renderHook, waitFor } from '@testing-library/react';
import { useTransactionSimulation } from '../useTransactionSimulation';
import type { FeeEstimate } from '@/lib/simulateFee';

describe('useTransactionSimulation', () => {
  it('re-runs when the simulation function changes while enabled stays true (#1236)', async () => {
    const first = jest.fn().mockResolvedValue({ minResourceFee: 1, instructions: 1, feeInXlm: 1 });
    const second = jest.fn().mockResolvedValue({ minResourceFee: 2, instructions: 2, feeInXlm: 2 });

    const { result, rerender } = renderHook(
      ({ fn }: { fn: () => Promise<FeeEstimate> | null }) => useTransactionSimulation(fn, true),
      { initialProps: { fn: first } },
    );

    await waitFor(() =>
      expect(result.current.feeEstimate).toEqual({
        minResourceFee: 1,
        instructions: 1,
        feeInXlm: 1,
      }),
    );

    // Inputs change => caller supplies a new memoised simulateFn, but `enabled`
    // is still true. The hook must re-run and surface the new fee estimate
    // rather than holding the stale one.
    rerender({ fn: second });

    await waitFor(() =>
      expect(result.current.feeEstimate).toEqual({
        minResourceFee: 2,
        instructions: 2,
        feeInXlm: 2,
      }),
    );

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('success');
  });

  it('does not simulate while disabled', async () => {
    const fn = jest.fn().mockResolvedValue({ minResourceFee: 1, instructions: 1, feeInXlm: 1 });
    const { result } = renderHook(() => useTransactionSimulation(fn, false));

    expect(result.current.status).toBe('idle');
    expect(fn).not.toHaveBeenCalled();
  });
});

import { useState, useEffect } from 'react';
import type { FeeEstimate } from '@/lib/simulateFee';

export type SimulationStatus = 'idle' | 'loading' | 'success' | 'error';

export interface SimulationState {
  status: SimulationStatus;
  feeEstimate: FeeEstimate | null;
  error: string | null;
}

export function useTransactionSimulation(
  simulateFn: () => Promise<FeeEstimate> | null,
  enabled: boolean,
): SimulationState {
  const [status, setStatus] = useState<SimulationStatus>('idle');
  const [feeEstimate, setFeeEstimate] = useState<FeeEstimate | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- intentional async-init
       effect: state is seeded synchronously when the (re)simulation starts,
       which is the correct behaviour here and would otherwise cascade only on
       real input/enabled changes. */
    if (!enabled) {
      setStatus('idle');
      setFeeEstimate(null);
      setError(null);
      return;
    }

    let cancelled = false;

    async function run() {
      setStatus('loading');
      setError(null);

      try {
        const fn = simulateFn();
        if (!fn) {
          if (!cancelled) setStatus('idle');
          return;
        }
        const result = await fn;
        if (!cancelled) {
          setFeeEstimate(result);
          setStatus('success');
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Simulation failed');
          setStatus('error');
        }
      }
    }

    run();

    return () => {
      cancelled = true;
    };
    // `simulateFn` is memoised by callers (via useCallback) against the inputs
    // it closes over, so including it here re-runs the simulation whenever those
    // inputs change while `enabled` stays true — previously it only re-ran when
    // `enabled` toggled.
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [enabled, simulateFn]);

  return { status, feeEstimate, error };
}

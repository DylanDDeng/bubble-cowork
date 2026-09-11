import { useEffect, useState } from 'react';
import type { ProviderCostEstimate, StreamMessage } from '../../shared/types';

/** Refresh only when a turn result arrives or history/session is replaced. */
export function useDeepseekSessionCost(sessionId: string | undefined, latestResult: StreamMessage | undefined) {
  const [state, setState] = useState<{ sessionId: string; cost: ProviderCostEstimate }>();
  useEffect(() => {
    // A renderer hot update can precede the main process/preload restart.
    if (!sessionId || typeof window.electron.getDeepseekSessionCost !== 'function') return;
    let cancelled = false;
    window.electron.getDeepseekSessionCost(sessionId).then((cost) => {
      if (!cancelled) setState({ sessionId, cost });
    }).catch(() => {
      if (!cancelled) setState({ sessionId, cost: { usd: null } });
    });
    return () => { cancelled = true; };
  }, [sessionId, latestResult]);
  return state?.sessionId === sessionId ? state?.cost : undefined;
}

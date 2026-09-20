import { useEffect, useSyncExternalStore } from 'react';
import { createPlanUsageCache } from '../utils/plan-usage-cache';

const planUsageCaches = {
  claude: createPlanUsageCache(() => window.electron.getClaudePlanUsage()),
  codex: createPlanUsageCache(() => window.electron.getCodexRateLimits()),
  grok: createPlanUsageCache(() => window.electron.getGrokPlanUsage()),
  qoder: createPlanUsageCache(() => window.electron.getQoderPlanUsage()),
};

export function usePlanUsage<P extends keyof typeof planUsageCaches>(provider: P, enabled: boolean) {
  const cache = planUsageCaches[provider];
  const snapshot = useSyncExternalStore(
    cache.subscribe,
    cache.getSnapshot as () => ReturnType<(typeof planUsageCaches)[P]['getSnapshot']>,
  );

  useEffect(() => {
    if (!enabled) return;
    void cache.refresh();
    const timer = window.setInterval(() => { void cache.refresh(); }, 60_000);
    return () => window.clearInterval(timer);
  }, [cache, enabled]);

  return snapshot;
}

import { useEffect, useSyncExternalStore } from 'react';
import type { AgentProvider, ClaudeUsageReport, ClaudeUsageRangeDays } from '../types';
import { createPlanUsageCache } from '../utils/plan-usage-cache';

// Keep each provider AND time range separate: a 30-day menu summary must never
// become the yearly detail report. Remounts share snapshots and pending queries.
const caches = new Map<string, ReturnType<typeof createCache>>();
function createCache(provider: AgentProvider, days: ClaudeUsageRangeDays) {
  return createPlanUsageCache(async (): Promise<{ fetchedAt: number; usage: ClaudeUsageReport | null }> => ({
    usage: await window.electron.getAgentUsageReport(provider, days),
    fetchedAt: Date.now(),
  }));
}

function getCache(provider: AgentProvider, days: ClaudeUsageRangeDays) {
  const key = `${provider}:${days}`;
  let cache = caches.get(key);
  if (!cache) {
    cache = createCache(provider, days);
    caches.set(key, cache);
  }
  return cache;
}

export function prefetchAgentUsageReport(provider: AgentProvider, days: ClaudeUsageRangeDays = 365) {
  return getCache(provider, days).refresh();
}

export function useAgentUsageReport(provider: AgentProvider, days: ClaudeUsageRangeDays, enabled = true) {
  const cache = getCache(provider, days);
  const snapshot = useSyncExternalStore(cache.subscribe, cache.getSnapshot);
  useEffect(() => {
    if (!enabled) return;
    void cache.refresh();
    const timer = window.setInterval(() => { void cache.refresh(); }, 60_000);
    return () => window.clearInterval(timer);
  }, [cache, enabled]);
  return snapshot;
}

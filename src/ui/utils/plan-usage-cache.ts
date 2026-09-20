export interface PlanUsageSnapshot<T> {
  report: T | null;
  loading: boolean;
  error: string | null;
}

// Keep snapshots outside React so closing Settings or switching agents does not
// discard either the last result or an unfinished request. No credentials or
// account data are persisted to browser storage.
export function createPlanUsageCache<T extends { fetchedAt: number }>(
  load: () => Promise<T | null>,
  now = Date.now,
  ttlMs = 60_000,
) {
  let snapshot: PlanUsageSnapshot<T> = { report: null, loading: true, error: null };
  let nextRefreshAt = 0;
  let inflight: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: PlanUsageSnapshot<T>) => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    refresh(): Promise<void> {
      if (inflight) return inflight;
      if (now() < nextRefreshAt) return Promise.resolve();
      // Back off after failures too, including when Settings is reopened.
      nextRefreshAt = now() + ttlMs;
      // Defer the loader so even a synchronous bridge failure is handled and
      // every concurrent subscriber joins the same request.
      inflight = Promise.resolve().then(load).then((report) => {
        publish({
          report,
          loading: false,
          error: report && now() - report.fetchedAt > ttlMs
            ? 'Latest usage is unavailable. Showing the last update.'
            : null,
        });
      }).catch((error: unknown) => {
        publish({
          report: snapshot.report,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }).finally(() => {
        inflight = null;
      });
      publish({ ...snapshot, loading: true, error: null });
      return inflight;
    },
  };
}

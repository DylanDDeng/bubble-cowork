import assert from 'node:assert/strict';
import { createPlanUsageCache } from '../../src/ui/utils/plan-usage-cache';

async function main() {
  let now = 1_000;
  let calls = 0;
  type Report = { fetchedAt: number; remaining: number };
  let resolve!: (report: Report | null) => void;
  let reject!: (error: Error) => void;
  const cache = createPlanUsageCache(() => {
    calls++;
    return new Promise<Report | null>((yes, no) => { resolve = yes; reject = no; });
  }, () => now);
  let notifications = 0;
  const unsubscribe = cache.subscribe(() => { notifications++; });
  const first = cache.refresh();
  await Promise.resolve();
  assert.equal(cache.getSnapshot().loading, true);
  assert.equal(cache.refresh(), first, 'concurrent mounts join one query');
  assert.equal(calls, 1);
  unsubscribe();
  const initial = { fetchedAt: now, remaining: 75 };
  resolve(initial);
  await first;
  assert.equal(cache.getSnapshot().report, initial, 'query finishes even after leaving Settings');
  assert.equal(notifications, 1, 'unmounted view is unsubscribed');
  await cache.refresh();
  assert.equal(calls, 1, 'reopening within TTL needs no query');

  now += 60_000;
  const refresh = cache.refresh();
  await Promise.resolve();
  assert.equal(cache.getSnapshot().report, initial, 'stale balance stays visible during slow refresh');
  assert.equal(cache.getSnapshot().loading, true);
  assert.equal(cache.refresh(), refresh, 'switching away and back cannot duplicate refresh');
  reject(new Error('Offline'));
  await refresh;
  assert.equal(cache.getSnapshot().report, initial, 'failed refresh retains the balance');
  assert.equal(cache.getSnapshot().error, 'Offline');
  assert.equal(cache.getSnapshot().loading, false);
  await cache.refresh();
  assert.equal(calls, 2, 'failures back off across remounts');

  now += 60_000;
  const recovery = cache.refresh();
  await Promise.resolve();
  const updated = { fetchedAt: now, remaining: 50 };
  resolve(updated);
  await recovery;
  assert.equal(cache.getSnapshot().report, updated);
  assert.equal(cache.getSnapshot().error, null);

  now += 60_001;
  const fallback = cache.refresh();
  await Promise.resolve();
  resolve(updated);
  await fallback;
  assert.match(cache.getSnapshot().error!, /Showing the last update/, 'backend cache fallback is identified');

  now += 60_000;
  const empty = cache.refresh();
  await Promise.resolve();
  resolve(null);
  await empty;
  assert.equal(cache.getSnapshot().report, null, 'explicit no-data result replaces previous account data');

  const other = createPlanUsageCache(async () => { throw new Error('Not signed in'); });
  await other.refresh();
  assert.equal(other.getSnapshot().report, null, 'providers never share balances');
  assert.equal(other.getSnapshot().error, 'Not signed in');
  console.log('plan-usage-cache: all assertions passed');
}

void main();

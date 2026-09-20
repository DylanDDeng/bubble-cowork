import type {
  ClaudePlanUsageReport, ClaudeUsageReport, CodexRateLimitReport,
  CodexRateLimitWindow, GrokPlanUsageReport, QoderPlanUsageReport,
} from '../types';

function remaining(used: number | null | undefined): string | null {
  return typeof used === 'number' && Number.isFinite(used)
    ? `${Math.round(Math.max(0, Math.min(100, 100 - used)))}%`
    : null;
}

export function claudeUsageSummary(report: ClaudePlanUsageReport | null): string | null {
  if (!report?.rateLimitsAvailable) return null;
  const windows = [
    ['5h', remaining(report.fiveHour?.utilization)],
    ['Weekly', remaining(report.sevenDay?.utilization)],
  ].filter(([, value]) => value !== null);
  return windows.length ? `Remaining · ${windows.map(([label, value]) => `${label} ${value}`).join(' · ')}` : null;
}

function codexWindowSummary(window: CodexRateLimitWindow | null, fallback: string): string | null {
  if (!window) return null;
  const value = remaining(window.usedPercent);
  if (value === null) return null;
  const minutes = window.windowDurationMins;
  const label = !minutes ? fallback : minutes === 10_080 ? 'Weekly'
    : minutes % 1440 === 0 ? `${minutes / 1440}d`
    : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
  return `${label} ${value}`;
}

export function codexUsageSummary(report: CodexRateLimitReport | null): string | null {
  if (!report) return null;
  // Match the detail page's preference for the main Codex bucket.
  const buckets = { ...report.rateLimitsByLimitId };
  if (report.rateLimits) {
    const id = report.rateLimits.limitId || 'codex';
    buckets[id] ??= report.rateLimits;
  }
  const main = buckets.codex || Object.entries(buckets)
    .sort(([a, left], [b, right]) => (left.limitName || left.limitId || a).localeCompare(right.limitName || right.limitId || b))[0]?.[1];
  if (!main) return null;
  const windows = [codexWindowSummary(main.primary, 'Primary'), codexWindowSummary(main.secondary, 'Secondary')].filter(Boolean);
  if (windows.length) return `Remaining · ${windows.join(' · ')}`;
  if (main.credits?.unlimited) return 'Credits · Unlimited';
  return main.credits?.balance ? `Credits · ${main.credits.balance}` : null;
}

export function grokUsageSummary(report: GrokPlanUsageReport | null): string | null {
  const value = remaining(report?.creditUsagePercent);
  if (value === null) return null;
  const type = report?.currentPeriod?.type?.toUpperCase() || '';
  const period = type.includes('WEEK') ? 'Weekly' : type.includes('MONTH') ? 'Monthly' : type.includes('DAILY') ? 'Daily' : 'Current period';
  return `${period} · ${value} remaining`;
}

export function qoderUsageSummary(report: QoderPlanUsageReport | null): string | null {
  const value = remaining(report?.totalUsagePercentage ?? report?.userQuota?.percentage);
  return value === null ? null : `Plan quota · ${value} remaining`;
}

export function tokenUsageSummary(report: ClaudeUsageReport | null): string {
  if (!report) return 'No usage data';
  const tokens = report.daily.reduce((sum, day) => sum + day.totalTokens, 0);
  if (tokens <= 0) return report.totals.sessionCount > 0 ? 'Tokens not reported' : 'No usage in last 30 days';
  const formatted = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(tokens);
  return `Last 30 days · ${formatted} tokens`;
}

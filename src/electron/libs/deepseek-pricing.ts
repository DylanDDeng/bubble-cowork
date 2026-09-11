export interface DeepseekBillableUsage {
  /** Uncached input tokens. Harness reports cache reads separately. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  /** Output subdivision only; never billed in addition to outputTokens. */
  reasoningTokens?: number;
}

interface DeepseekPriceEntry {
  cacheHitInputUsdPerMillion: number;
  cacheMissInputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

export const DEEPSEEK_COST_ACCOUNTING = 'deepseek-request-pricing-2026-09-10-v1';
// The release specifies September 10, but not an activation minute. For
// historical estimates use the start of that date in UTC, not a claimed
// billing cutover. The announced Pro reroute DOES specify an exact time.
const V41_START_MS = Date.UTC(2026, 8, 10);
const PRO_REROUTE_MS = Date.UTC(2026, 8, 14, 4);
const NEW_SCHEDULE_START_MS = Date.UTC(2026, 7, 16, 16, 0, 0);

// Official DeepSeek API list prices, USD per 1M tokens. Verified 2026-09-10:
// https://api-docs.deepseek.com/quick_start/pricing
// The announced peak/off-peak schedule starts at 2026-08-16 16:00 UTC.
const LEGACY_PRICES: Record<'flash' | 'pro', DeepseekPriceEntry> = {
  flash: {
    cacheHitInputUsdPerMillion: 0.0028,
    cacheMissInputUsdPerMillion: 0.14,
    outputUsdPerMillion: 0.28,
  },
  pro: {
    cacheHitInputUsdPerMillion: 0.003625,
    cacheMissInputUsdPerMillion: 0.435,
    outputUsdPerMillion: 0.87,
  },
};

const SCHEDULED_PRICES: Record<
  'flash' | 'pro',
  { offPeak: DeepseekPriceEntry; peak: DeepseekPriceEntry }
> = {
  flash: {
    offPeak: {
      cacheHitInputUsdPerMillion: 0.007,
      cacheMissInputUsdPerMillion: 0.22,
      outputUsdPerMillion: 0.66,
    },
    peak: {
      cacheHitInputUsdPerMillion: 0.014,
      cacheMissInputUsdPerMillion: 0.44,
      outputUsdPerMillion: 1.32,
    },
  },
  pro: {
    offPeak: {
      cacheHitInputUsdPerMillion: 0.022,
      cacheMissInputUsdPerMillion: 0.66,
      outputUsdPerMillion: 1.98,
    },
    peak: {
      cacheHitInputUsdPerMillion: 0.044,
      cacheMissInputUsdPerMillion: 1.32,
      outputUsdPerMillion: 3.96,
    },
  },
};

function normalizeCount(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, value || 0) : 0;
}

const V41_PRICES = {
  offPeak: { cacheHitInputUsdPerMillion: 0.003, cacheMissInputUsdPerMillion: 0.15, outputUsdPerMillion: 0.6 },
  peak: { cacheHitInputUsdPerMillion: 0.006, cacheMissInputUsdPerMillion: 0.30, outputUsdPerMillion: 1.2 },
};

/** Exact documented ids only: a custom model named like a tier is not a price. */
export function getDeepseekPrice(model: string | undefined, atMs = Date.now()): DeepseekPriceEntry | null {
  if (!Number.isFinite(atMs)) return null;
  const id = model?.trim() || '';
  const period = isDeepseekPeakPeriod(atMs) ? 'peak' : 'offPeak';
  if (id === 'deepseek-flash' || id === 'deepseek-v4-flash-vision-exp') {
    return atMs >= V41_START_MS ? V41_PRICES[period] : null;
  }
  if (id !== 'deepseek-v4-flash' && id !== 'deepseek-v4-pro') return null;
  if ((id === 'deepseek-v4-flash' && atMs >= V41_START_MS) ||
      (id === 'deepseek-v4-pro' && atMs >= PRO_REROUTE_MS)) return V41_PRICES[period];
  const tier = id === 'deepseek-v4-flash' ? 'flash' : 'pro';
  return atMs < NEW_SCHEDULE_START_MS ? LEGACY_PRICES[tier] : SCHEDULED_PRICES[tier][period];
}

export function isDeepseekPeakPeriod(atMs: number): boolean {
  if (!Number.isFinite(atMs) || atMs < NEW_SCHEDULE_START_MS) return false;
  const date = new Date(atMs);
  if (date.getUTCDay() === 0 || date.getUTCDay() === 6) return false;
  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  return (
    (utcMinutes >= 60 && utcMinutes < 4 * 60) ||
    (utcMinutes >= 6 * 60 && utcMinutes < 10 * 60)
  );
}

export function estimateDeepseekUsageCost(
  model: string | undefined,
  usage: DeepseekBillableUsage,
  atMs = Date.now()
): number | null {
  const price = getDeepseekPrice(model, atMs);
  if (!price) return null;

  return (
    (normalizeCount(usage.inputTokens) * price.cacheMissInputUsdPerMillion) / 1_000_000 +
    (normalizeCount(usage.cacheReadTokens) * price.cacheHitInputUsdPerMillion) / 1_000_000 +
    (normalizeCount(usage.outputTokens) * price.outputUsdPerMillion) / 1_000_000
  );
}

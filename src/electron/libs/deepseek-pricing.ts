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

const NEW_SCHEDULE_START_MS = Date.UTC(2026, 7, 16, 16, 0, 0);

// Official DeepSeek API list prices, USD per 1M tokens. Verified 2026-08-14:
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

function resolveModelTier(model: string | undefined): 'flash' | 'pro' | null {
  const normalized = model?.trim().toLowerCase() || '';
  if (/^deepseek-v4-flash(?:$|-)/.test(normalized)) return 'flash';
  if (/^deepseek-v4-pro(?:$|-)/.test(normalized)) return 'pro';
  return null;
}

export function isDeepseekPeakPeriod(atMs: number): boolean {
  if (!Number.isFinite(atMs) || atMs < NEW_SCHEDULE_START_MS) return false;
  const date = new Date(atMs);
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
): number {
  const tier = resolveModelTier(model);
  if (!tier) return 0;

  const price =
    atMs < NEW_SCHEDULE_START_MS
      ? LEGACY_PRICES[tier]
      : SCHEDULED_PRICES[tier][isDeepseekPeakPeriod(atMs) ? 'peak' : 'offPeak'];

  return (
    (normalizeCount(usage.inputTokens) * price.cacheMissInputUsdPerMillion) / 1_000_000 +
    (normalizeCount(usage.cacheReadTokens) * price.cacheHitInputUsdPerMillion) / 1_000_000 +
    (normalizeCount(usage.outputTokens) * price.outputUsdPerMillion) / 1_000_000
  );
}

/** Current Standard API token rates, USD per million tokens.
 * Verified 2026-09-20: https://developers.openai.com/api/docs/pricing
 * Context rule: https://developers.openai.com/api/docs/models/gpt-6-astra
 * Cache writes replace the uncached-input rate; they are not an additive fee.
 * This is a current API-equivalent estimate, not historical subscription billing.
 */
export const CODEX_API_PRICING_URL = 'https://developers.openai.com/api/docs/pricing';
export const CODEX_API_PRICING_VERIFIED_AT = '2026-09-20';

interface CodexPrice {
  input: number;
  cached: number | null;
  output: number;
  cacheWrite?: number;
  longContext?: boolean;
}
const PRICES: Record<string, CodexPrice> = {
  'gpt-6-astra': { input: 10, cached: 1, cacheWrite: 12.5, output: 50, longContext: true },
  'gpt-5.6-sol': { input: 4, cached: 0.4, cacheWrite: 5, output: 20, longContext: true },
  'gpt-5.6-terra': { input: 2, cached: 0.2, cacheWrite: 2.5, output: 12, longContext: true },
  'gpt-5.6-luna': { input: 0.2, cached: 0.02, cacheWrite: 0.25, output: 1.2, longContext: true },
  'gpt-5.5': { input: 5, cached: 0.5, output: 30, longContext: true },
  'gpt-5.5-pro': { input: 30, cached: null, output: 180, longContext: true },
  'gpt-5.4': { input: 2.5, cached: 0.25, output: 15, longContext: true },
  'gpt-5.4-pro': { input: 30, cached: null, output: 180, longContext: true },
  'gpt-5.4-mini': { input: 0.75, cached: 0.075, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, cached: 0.02, output: 1.25 },
  'gpt-5.3-codex': { input: 1.75, cached: 0.175, output: 14 },
  'gpt-5.2': { input: 1.75, cached: 0.175, output: 14 },
  'gpt-5.2-codex': { input: 1.75, cached: 0.175, output: 14 },
  'gpt-5.2-pro': { input: 21, cached: null, output: 168 },
  'gpt-5.1': { input: 1.25, cached: 0.125, output: 10 },
  'gpt-5.1-codex': { input: 1.25, cached: 0.125, output: 10 },
};

export function getCodexPriceEntry(model: string): CodexPrice | null {
  const id = model.trim().toLowerCase();
  // Match dated snapshots, but never infer the price of an unknown family suffix.
  return PRICES[id] ?? PRICES[id.replace(/-\d{4}-\d{2}-\d{2}$/, '')] ?? null;
}

export interface CodexTokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens?: number;
  outputTokens: number;
}

export function estimateCodexUsageCost(model: string, usage: CodexTokenUsage): number | null {
  const price = getCodexPriceEntry(model);
  if (!price) return null;
  const count = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
  const input = count(usage.inputTokens);
  const cached = price.cached === null ? 0 : Math.min(input, count(usage.cachedInputTokens));
  const written = Math.min(input - cached, count(usage.cacheWriteInputTokens));
  const uncached = input - cached - written;
  // Apply the threshold to this request, never to a session/model aggregate.
  const longContext = price.longContext && input > 272_000;
  const inputMultiplier = longContext ? 2 : 1;
  const outputMultiplier = longContext ? 1.5 : 1;
  return ((uncached * price.input + cached * (price.cached ?? price.input)
    + written * (price.cacheWrite ?? price.input)) * inputMultiplier
    + count(usage.outputTokens) * price.output * outputMultiplier) / 1_000_000;
}

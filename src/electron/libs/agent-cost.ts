import type { AgentProvider, ProviderCostDetails, Usage } from '../../shared/types';
import { estimateCodexUsageCost, getCodexPriceEntry } from './codex-pricing';
import { estimateDeepseekUsageCost } from './deepseek-pricing';

export const validUsd = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function emptyCostDetails(): ProviderCostDetails {
  return { reportedUsd: 0, estimatedUsd: 0, reportedCount: 0, estimatedCount: 0, unpricedCount: 0 };
}

/** Public API rates. Subscription aliases below use explicit estimate proxies.
 * USD / million, verified 2026-09-20:
 * https://docs.z.ai/guides/overview/pricing
 * https://docs.x.ai/developers/models (default US region, excluding tool fees)
 * https://platform.kimi.ai/docs/pricing/chat (international API equivalent)
 */
const API_PRICES: Record<string, [number, number, number]> = {
  'glm-5.3': [1.4, 0.26, 4.4],
  'glm-5.3-flash': [0.15, 0.03, 0.5],
  'glm-5.3-flashx': [0.37, 0.075, 1.25],
  'glm-5.2': [1.4, 0.26, 4.4],
  'glm-5.1': [1.4, 0.26, 4.4],
  'glm-5': [1, 0.2, 3.2],
  'grok-4.6': [2, 0.5, 6],
  'grok-4.5': [2, 0.3, 6],
  'kimi-k3': [3, 0.3, 15],
  'kimi-k2.7-code': [0.95, 0.19, 4],
  'kimi-k2.7-code-highspeed': [1.9, 0.38, 8],
  'kimi-k2.6': [0.95, 0.16, 4],
};

/** Current API equivalents for Kimi subscription names, not a claim about
 * the historical backend behind a rolling alias. Keep unknown names unknown. */
const KIMI_ESTIMATE_MODELS: Record<string, string> = {
  k3: 'kimi-k3',
  'kimi-for-coding': 'kimi-k3',
  'kimi-for-coding-highspeed': 'kimi-k2.7-code-highspeed',
};

// https://platform.claude.com/docs/en/about-claude/pricing, verified 2026-09-20.
const CLAUDE_PRICES: Record<string, [number, number, number]> = {
  'claude-fable-5-1': [10, 0.25, 50], 'claude-mythos-5-1': [10, 0.25, 50],
  'claude-fable-5': [10, 1, 50], 'claude-mythos-5': [10, 1, 50],
  'claude-opus-5': [5, 0.5, 25], 'claude-opus-4-8': [5, 0.5, 25],
  'claude-opus-4-7': [5, 0.5, 25], 'claude-opus-4-6': [5, 0.5, 25],
  'claude-opus-4-5': [5, 0.5, 25], 'claude-sonnet-5': [2, 0.2, 10],
  'claude-sonnet-4-6': [3, 0.3, 15], 'claude-sonnet-4-5': [3, 0.3, 15],
  'claude-haiku-4-5': [1, 0.1, 5],
};

export function estimateAgentApiCost(
  provider: AgentProvider, model: string, usage: Usage | null | undefined,
  atMs = Date.now(), perRequest = false,
): number | null {
  if (!usage) return null;
  const qualifiedModel = model.trim().toLowerCase();
  const rawId = qualifiedModel.split(/[/:]/).pop() || '';
  const kimiModel = provider === 'kimi' || /^(kimi-code|kimi-for-coding|moonshot(?:-cn|-ai)?)[/:]/.test(qualifiedModel);
  const id = kimiModel ? KIMI_ESTIMATE_MODELS[rawId] || rawId : rawId;
  const count = (n: unknown) => validUsd(n) ? n : 0;
  const read = count(usage.cache_read_input_tokens);
  const write = count(usage.cache_creation_input_tokens);
  // Grok's legacy Claude-compatible records and native ACP records do not
  // yet carry a cache-bucket accounting version. A missing-cost cached turn
  // cannot safely establish whether input includes those buckets.
  if (provider === 'grok' && (read > 0 || write > 0)) return null;
  // Bubble SDK promptTokens includes cached input; Pi/Claude/OpenCode/Kimi
  // expose uncached input and cache buckets separately.
  const includesCache = provider === 'bubble' || provider === 'codex';
  const input = Math.max(0, count(usage.input_tokens) - (includesCache ? read + write : 0));
  const output = count(usage.output_tokens);
  const allInput = input + read + write;
  // A known model's explicitly reported zero usage contributes zero; context
  // occupancy alone still cannot be used as billable usage.
  if (allInput + output === 0 && (count(usage.total_tokens) > 0
    || !validUsd(usage.input_tokens) || !validUsd(usage.output_tokens))) return null;
  const claude = CLAUDE_PRICES[id.replace(/-\d{8}$/, '').replaceAll('.', '-')];
  if (claude) {
    // Older Sonnet 4.5 has per-request long-context pricing; aggregated
    // records above its boundary cannot be reconstructed safely.
    if (id.startsWith('claude-sonnet-4-5') && allInput > 200_000) return null;
    const cache = (usage as Usage & { cache_creation?: { ephemeral_1h_input_tokens?: number } }).cache_creation;
    const hour = Math.min(write, count(cache?.ephemeral_1h_input_tokens));
    // Without a TTL split do not silently price unknown writes at 5m rates.
    if (write > 0 && !cache) return null;
    return (input * claude[0] + read * claude[1] + (write - hour) * claude[0] * 1.25
      + hour * claude[0] * 2 + output * claude[2]) / 1_000_000;
  }
  const openai = getCodexPriceEntry(id);
  if (openai) {
    // A turn aggregate cannot tell whether any individual request crossed
    // the long-context boundary. Never apply a per-request premium to it.
    if (!perRequest && openai.longContext && allInput > 272_000) return null;
    return estimateCodexUsageCost(id, { inputTokens: allInput, cachedInputTokens: read,
      cacheWriteInputTokens: write, outputTokens: output });
  }
  const deepseek = write === 0 ? estimateDeepseekUsageCost(id,
    { inputTokens: input, outputTokens: output, cacheReadTokens: read }, atMs) : null;
  if (deepseek !== null) return deepseek;
  const price = API_PRICES[id];
  if (id === 'kimi-k3' && price) {
    const cache = (usage as Usage & { cache_creation?: { ephemeral_1h_input_tokens?: number } }).cache_creation;
    // Estimate unspecified TTL at the official API default of 5 minutes.
    const hour = Math.min(write, count(cache?.ephemeral_1h_input_tokens));
    return (input * price[0] + read * price[1] + (write - hour) * 3 + hour * 6 + output * price[2]) / 1_000_000;
  }
  if (!price) return null;
  const grok = id.startsWith('grok-');
  if (grok && !perRequest && allInput >= 200_000) return null;
  const multiplier = grok && allInput >= 200_000 ? 2 : 1;
  // These APIs have no separate cache-write token tier: newly written
  // tokens are ordinary cache-miss input (cache storage is not a token fee).
  return ((input + write) * price[0] + read * price[1] + output * price[2]) * multiplier / 1_000_000;
}

/** Resolve each request before summing: preserve returned zero and never
 * replace a partially reported turn with an estimate of the entire turn. */
export function addAgentCost(
  details: ProviderCostDetails, provider: AgentProvider, model: string,
  usage: Usage | null | undefined, reportedUsd: unknown, atMs = Date.now(), perRequest = true,
): void {
  if (validUsd(reportedUsd)) {
    details.reportedUsd += reportedUsd;
    details.reportedCount += 1;
    return;
  }
  const estimate = estimateAgentApiCost(provider, model, usage, atMs, perRequest);
  if (estimate === null) details.unpricedCount += 1;
  else { details.estimatedUsd += estimate; details.estimatedCount += 1; }
}

export function costFields(details: ProviderCostDetails) {
  const snapshot = { ...details };
  if (!(snapshot.reportedCount + snapshot.estimatedCount + snapshot.unpricedCount)) snapshot.unpricedCount = 1;
  return {
    total_cost_usd: details.reportedUsd + details.estimatedUsd,
    costSource: details.unpricedCount || !(details.reportedCount + details.estimatedCount)
      ? 'unavailable' as const : details.estimatedCount ? 'estimated' as const : 'reported' as const,
    costDetails: snapshot,
  };
}

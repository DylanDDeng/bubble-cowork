import assert from 'node:assert/strict';
import { estimateCodexUsageCost as cost, getCodexPriceEntry } from '../../src/electron/libs/codex-pricing';
const close = (actual: number | null, expected: number) => assert(actual !== null && Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
// Independent official-rate examples: uncached 60K, cached 30K, writes 10K, output 2K.
for (const [model, expected] of [
  ['gpt-6-astra', .855], ['gpt-5.6-sol', .342], ['gpt-5.6-terra', .175], ['gpt-5.6-luna', .0175],
] as const) {
  close(cost(model, { inputTokens: 100000, cachedInputTokens: 30000, cacheWriteInputTokens: 10000, outputTokens: 2000 }), expected);
}
close(cost('gpt-5.6-sol', { inputTokens: 272000, cachedInputTokens: 100000, outputTokens: 1000 }), .748);
close(cost('gpt-5.6-sol', { inputTokens: 272001, cachedInputTokens: 100000, outputTokens: 1000 }), 1.486008);
close(cost('gpt-6-astra', { inputTokens: 300000, cachedInputTokens: 200000, cacheWriteInputTokens: 50000, outputTokens: 1000 }), 2.725);
close(cost('gpt-5.5', { inputTokens: 300000, cachedInputTokens: 200000, outputTokens: 1000 }), 1.245);
close(cost('gpt-5.5-pro', { inputTokens: 100000, cachedInputTokens: 0, outputTokens: 1000 }), 3.18);
close(cost(' GPT-5.6-SOL-2026-08-01 ', { inputTokens: 100000, cachedInputTokens: 0, outputTokens: 1000 }), .42);
close(cost('gpt-5.6-terra', { inputTokens: 100, cachedInputTokens: 1000, cacheWriteInputTokens: 1000, outputTokens: 0 }), .00002);
assert.equal(getCodexPriceEntry('gpt-5.6-sol-unknown'), null);
assert.equal(cost('unreleased-model', { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 10 }), null);
console.log('codex-pricing: official rates, cache reads/writes, request thresholds, snapshots and unknown models passed');

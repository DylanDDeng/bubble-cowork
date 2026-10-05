import type { ClaudeCompatibleProviderId } from '../types';

/** Display names for Claude-compatible providers (pure; shared with the phone). */
export const COMPATIBLE_PROVIDER_LABELS: Record<ClaudeCompatibleProviderId, string> = {
  minimaxCn: 'MiniMax (CN)',
  minimax: 'MiniMax (GLOBAL)',
  mimo: 'MiMo',
  zhipu: 'Zhipu AI',
  moonshot: 'Moonshot AI',
  deepseek: 'DeepSeek',
};

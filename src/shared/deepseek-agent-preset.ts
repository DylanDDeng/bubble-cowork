import type { DeepseekAgentPreset } from './types';

export const DEFAULT_DEEPSEEK_AGENT_PRESET: DeepseekAgentPreset = 'standard';

export function normalizeDeepseekAgentPreset(value: unknown): DeepseekAgentPreset {
  return value === 'code' || value === 'minimal' || value === 'cordis'
    ? value
    : DEFAULT_DEEPSEEK_AGENT_PRESET;
}

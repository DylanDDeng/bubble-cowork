import type { DeepseekReasoningEffort } from '../types';
import { rendererStateStorage } from './renderer-state-storage';

const STORAGE_KEY = 'cowork.preferredDeepseekReasoningEffort';

export const DEFAULT_DEEPSEEK_REASONING_EFFORT: DeepseekReasoningEffort = 'max';

export const DEEPSEEK_REASONING_EFFORT_OPTIONS: ReadonlyArray<DeepseekReasoningEffort> = [
  'off',
  'low',
  'high',
  'max',
];

export const DEEPSEEK_REASONING_EFFORT_LABELS: Record<DeepseekReasoningEffort, string> = {
  off: 'Off',
  low: 'Low',
  high: 'High',
  max: 'Max',
};

export function normalizeDeepseekReasoningEffort(
  value: unknown
): DeepseekReasoningEffort | null {
  return value === 'off' || value === 'low' || value === 'high' || value === 'max' ? value : null;
}

export function loadPreferredDeepseekReasoningEffort(): DeepseekReasoningEffort {
  if (typeof window === 'undefined') return DEFAULT_DEEPSEEK_REASONING_EFFORT;
  return (
    normalizeDeepseekReasoningEffort(rendererStateStorage.getItem(STORAGE_KEY)) ||
    DEFAULT_DEEPSEEK_REASONING_EFFORT
  );
}

export function savePreferredDeepseekReasoningEffort(effort: DeepseekReasoningEffort): void {
  if (typeof window === 'undefined') return;
  rendererStateStorage.setItem(STORAGE_KEY, effort);
}

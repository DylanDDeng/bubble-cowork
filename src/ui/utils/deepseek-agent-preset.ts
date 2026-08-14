import type { DeepseekAgentPreset } from '../types';
import { normalizeDeepseekAgentPreset } from '../../shared/deepseek-agent-preset';
import { rendererStateStorage } from './renderer-state-storage';

const STORAGE_KEY = 'cowork.preferredDeepseekAgentPreset';

export function loadPreferredDeepseekAgentPreset(): DeepseekAgentPreset {
  if (typeof window === 'undefined') return 'standard';
  return normalizeDeepseekAgentPreset(rendererStateStorage.getItem(STORAGE_KEY));
}

export function savePreferredDeepseekAgentPreset(preset: DeepseekAgentPreset): void {
  if (typeof window === 'undefined') return;
  rendererStateStorage.setItem(STORAGE_KEY, normalizeDeepseekAgentPreset(preset));
}

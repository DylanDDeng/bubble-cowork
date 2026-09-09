import { rendererStateStorage } from './renderer-state-storage';
import { normalizeCodexReasoningEffort } from '../../shared/codex-reasoning';
import type { CodexModelConfig, CodexReasoningEffort, CodexReasoningLevelOption } from '../types';

const STORAGE_KEY = 'cowork.preferredCodexReasoningEfforts';

/**
 * Codex display labels are presentation only; selection and requests retain
 * the original effort ID. Unknown future tiers still get a readable label.
 */
export function formatCodexReasoningEffortLabel(effort: CodexReasoningEffort): string {
  const normalized = effort.trim().toLowerCase();
  if (!normalized) return effort;
  if (normalized === 'xhigh') return 'Extra High';
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
}

function loadStoredPreferences(): Record<string, CodexReasoningEffort> {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    const raw = rendererStateStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as Record<string, string>;
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([model, effort]) => [model, normalizeCodexReasoningEffort(effort)] as const)
        .filter((entry): entry is [string, CodexReasoningEffort] => Boolean(entry[1]))
    );
  } catch {
    return {};
  }
}

function saveStoredPreferences(preferences: Record<string, CodexReasoningEffort>): void {
  if (typeof window === 'undefined') {
    return;
  }

  rendererStateStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
}

export function loadPreferredCodexReasoningEffort(model: string | null): CodexReasoningEffort | null {
  if (!model) {
    return null;
  }

  return loadStoredPreferences()[model] || null;
}

export function savePreferredCodexReasoningEffort(
  model: string | null,
  effort: CodexReasoningEffort
): void {
  if (!model || typeof window === 'undefined') {
    return;
  }

  const preferences = loadStoredPreferences();
  preferences[model] = effort;
  saveStoredPreferences(preferences);
}

export function getCodexReasoningOptions(
  config: CodexModelConfig,
  model: string | null
): CodexReasoningLevelOption[] {
  const matched = config.availableModels.find((entry) => entry.name === model);
  if (matched?.supportedReasoningLevels) {
    return matched.supportedReasoningLevels;
  }

  // No catalog metadata means no advertised choices. Let Codex use its native default.
  return [];
}

export function getDefaultCodexReasoningEffort(
  config: CodexModelConfig,
  model: string | null
): CodexReasoningEffort | undefined {
  const options = getCodexReasoningOptions(config, model);
  const matched = config.availableModels.find((entry) => entry.name === model);
  const supports = (effort: CodexReasoningEffort | null | undefined): effort is CodexReasoningEffort =>
    Boolean(effort && (matched?.supportedReasoningLevels == null || options.some((option) => option.effort === effort)));

  // The user's explicit choices win over model metadata: per-model preference
  // saved in Aegis, then ~/.codex/config.toml `model_reasoning_effort` (what
  // Codex Desktop honors), then the model's own default from models_cache.
  const candidates = [
    loadPreferredCodexReasoningEffort(model),
    config.defaultReasoningEffort,
    matched?.defaultReasoningEffort,
  ];
  for (const candidate of candidates) {
    if (supports(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

import { rendererStateStorage } from './renderer-state-storage';
import type { CodexModelConfig, CodexReasoningEffort, CodexReasoningLevelOption } from '../types';

const STORAGE_KEY = 'cowork.preferredCodexReasoningEfforts';

function normalizeCodexReasoningEffort(
  raw: string | null | undefined
): CodexReasoningEffort | null {
  // Open vocabulary: the valid set is model-specific (models_cache
  // supported_reasoning_levels), so accept any non-empty slug instead of
  // whitelisting — otherwise new levels like "max"/"ultra" get dropped.
  const normalized = (raw || '').trim().toLowerCase();
  return normalized || null;
}

/**
 * Human label for an effort slug without a hardcoded per-level map, so new
 * Codex levels render sensibly with no code change ("ultra" → "Ultra").
 */
export function formatCodexReasoningEffortLabel(effort: CodexReasoningEffort): string {
  const normalized = effort.trim().toLowerCase();
  if (!normalized) return effort;
  if (normalized.startsWith('x') && normalized.length > 1) {
    // "xhigh" → "X-High" (matches Codex's own picker wording).
    const rest = normalized.slice(1);
    return `X-${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
  }
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
  if (matched?.supportedReasoningLevels && matched.supportedReasoningLevels.length > 0) {
    return matched.supportedReasoningLevels;
  }

  // Fallback only for models with no cached level metadata at all.
  return [
    { effort: 'low', description: 'Fast responses with lighter reasoning' },
    { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
    { effort: 'high', description: 'Greater reasoning depth for complex problems' },
    { effort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
  ];
}

export function getDefaultCodexReasoningEffort(
  config: CodexModelConfig,
  model: string | null
): CodexReasoningEffort {
  const options = getCodexReasoningOptions(config, model);
  const supports = (effort: CodexReasoningEffort | null | undefined): effort is CodexReasoningEffort =>
    Boolean(effort && (options.length === 0 || options.some((option) => option.effort === effort)));

  const matched = config.availableModels.find((entry) => entry.name === model);
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

  return options[0]?.effort || 'medium';
}

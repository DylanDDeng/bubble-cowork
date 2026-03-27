import type { CodexModelConfig, CodexReasoningEffort, CodexReasoningLevelOption } from '../types';

const STORAGE_KEY = 'cowork.preferredCodexReasoningEfforts';

function normalizeCodexReasoningEffort(
  raw: string | null | undefined
): CodexReasoningEffort | null {
  switch ((raw || '').trim().toLowerCase()) {
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return raw!.trim().toLowerCase() as CodexReasoningEffort;
    default:
      return null;
  }
}

function loadStoredPreferences(): Record<string, CodexReasoningEffort> {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
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

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
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
  const matched = config.availableModels.find((entry) => entry.name === model);
  return (
    loadPreferredCodexReasoningEffort(model) ||
    matched?.defaultReasoningEffort ||
    config.defaultReasoningEffort ||
    getCodexReasoningOptions(config, model)[0]?.effort ||
    'medium'
  );
}

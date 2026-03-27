import type { CodexModelConfig } from '../types';

const STORAGE_KEY = 'cowork.preferredCodexFastModeByModel';

export function supportsCodexFastMode(
  config: CodexModelConfig,
  model: string | null | undefined
): boolean {
  const matched = config.availableModels.find((entry) => entry.name === model);
  return matched?.supportsFastMode === true;
}

function loadPreferences(): Record<string, boolean> {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [key, value === true])
    );
  } catch {
    return {};
  }
}

function savePreferences(preferences: Record<string, boolean>): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
}

export function loadPreferredCodexFastMode(config: CodexModelConfig, model: string | null): boolean {
  if (!model || !supportsCodexFastMode(config, model)) {
    return false;
  }

  return loadPreferences()[model] === true;
}

export function savePreferredCodexFastMode(
  config: CodexModelConfig,
  model: string | null,
  enabled: boolean
): void {
  if (!model || !supportsCodexFastMode(config, model) || typeof window === 'undefined') {
    return;
  }

  const preferences = loadPreferences();
  preferences[model] = enabled;
  savePreferences(preferences);
}

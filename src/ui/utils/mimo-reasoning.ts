import { rendererStateStorage } from './renderer-state-storage';

const STORAGE_KEY = 'cowork.preferredMimoReasoningEfforts';
// '' keys the "Default" model row.
const DEFAULT_MODEL_KEY = '';

function loadStoredPreferences(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(rendererStateStorage.getItem(STORAGE_KEY) || '{}') as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1]))
    );
  } catch {
    return {};
  }
}

/** null clears the choice: the model then runs without a variant (MiMo's default). */
export function savePreferredMimoReasoningEffort(model: string | null, effort: string | null): void {
  if (typeof window === 'undefined') return;
  const preferences = loadStoredPreferences();
  const key = model || DEFAULT_MODEL_KEY;
  if (effort) preferences[key] = effort;
  else delete preferences[key];
  rendererStateStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
}

/**
 * Checked level for a model: the saved choice when the model still offers
 * it. MiMo has no per-model default variant, so anything else is null —
 * nothing sent, MiMo's own default applies.
 */
export function resolveMimoReasoningEffort(model: string | null, efforts: readonly string[]): string | null {
  if (efforts.length === 0) return null;
  const preferred = loadStoredPreferences()[model || DEFAULT_MODEL_KEY];
  return preferred && efforts.includes(preferred) ? preferred : null;
}

export function formatMimoReasoningEffortLabel(effort: string): string {
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

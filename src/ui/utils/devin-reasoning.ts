import { rendererStateStorage } from './renderer-state-storage';
import type { DevinThoughtLevels } from '../types';

const STORAGE_KEY = 'cowork.preferredDevinThoughtLevels';
// '' keys the "Default" model row, whose levels are the account default model's.
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

export function savePreferredDevinThoughtLevel(model: string | null, level: string): void {
  if (typeof window === 'undefined' || !level) return;
  const preferences = loadStoredPreferences();
  preferences[model || DEFAULT_MODEL_KEY] = level;
  rendererStateStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
}

/**
 * Checked level for a model: the user's saved choice when the model still
 * offers it, else Devin's own per-model default. A model without thinking
 * control resolves to null — nothing shown, nothing sent.
 */
export function resolveDevinThoughtLevel(model: string | null, levels: DevinThoughtLevels | null): string | null {
  if (!levels || levels.levels.length === 0) return null;
  const preferred = loadStoredPreferences()[model || DEFAULT_MODEL_KEY];
  if (preferred && levels.levels.some((level) => level.id === preferred)) return preferred;
  return levels.defaultLevel ?? levels.levels[0]?.id ?? null;
}

export function formatDevinThoughtLevelLabel(levels: DevinThoughtLevels | null, level: string): string {
  return levels?.levels.find((entry) => entry.id === level)?.label || level.charAt(0).toUpperCase() + level.slice(1);
}

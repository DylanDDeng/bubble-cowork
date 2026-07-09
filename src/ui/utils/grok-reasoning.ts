import { rendererStateStorage } from './renderer-state-storage';
import type { GrokReasoningEffort } from '../types';

const STORAGE_KEY = 'cowork.preferredGrokReasoningEfforts';

/**
 * UI-facing efforts for Grok Build.
 * Live ACP model metadata for grok-4.5 only advertises low / medium / high
 * (default high). Docs may mention xhigh for /effort, but the agent does not
 * list it — keep the picker aligned with what the CLI actually supports.
 */
export const GROK_REASONING_EFFORT_OPTIONS: GrokReasoningEffort[] = [
  'low',
  'medium',
  'high',
];

export const GROK_REASONING_EFFORT_LABELS: Record<GrokReasoningEffort, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
};

export function normalizeGrokReasoningEffort(
  raw: string | null | undefined
): GrokReasoningEffort | null {
  switch ((raw || '').trim().toLowerCase()) {
    case 'none':
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return raw!.trim().toLowerCase() as GrokReasoningEffort;
    default:
      return null;
  }
}

function loadStoredPreferences(): Record<string, GrokReasoningEffort> {
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
        .map(([model, effort]) => [model, normalizeGrokReasoningEffort(effort)] as const)
        .filter((entry): entry is [string, GrokReasoningEffort] => Boolean(entry[1]))
    );
  } catch {
    return {};
  }
}

function saveStoredPreferences(preferences: Record<string, GrokReasoningEffort>): void {
  if (typeof window === 'undefined') {
    return;
  }

  rendererStateStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
}

export function loadPreferredGrokReasoningEffort(model: string | null): GrokReasoningEffort | null {
  if (!model) {
    return null;
  }

  return loadStoredPreferences()[model] || null;
}

export function savePreferredGrokReasoningEffort(
  model: string | null,
  effort: GrokReasoningEffort
): void {
  if (!model || typeof window === 'undefined') {
    return;
  }

  const preferences = loadStoredPreferences();
  preferences[model] = effort;
  saveStoredPreferences(preferences);
}

export function getDefaultGrokReasoningEffort(model: string | null): GrokReasoningEffort {
  return loadPreferredGrokReasoningEffort(model) || 'high';
}

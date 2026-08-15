import { rendererStateStorage } from './renderer-state-storage';
import type { BubbleModelConfig } from '../types';

const STORAGE_KEY = 'cowork.preferredBubbleThinkingLevels';

/**
 * The SDK's full thinking-level union (dist/types.d.ts THINKING_LEVELS).
 * A given model advertises a subset via the catalog's reasoningLevels; the
 * picker only ever offers that subset, so this set is a shape guard for
 * stored/stale values, not the source of picker options.
 */
export const BUBBLE_THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;

export const BUBBLE_THINKING_LEVEL_LABELS: Record<string, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max',
  ultra: 'Ultra',
};

/**
 * Bubble thinking levels come from the SDK's fixed THINKING_LEVELS union
 * (off/minimal/low/medium/high/xhigh/max/ultra); which of them a model
 * actually supports is per-model catalog metadata (reasoningLevels), like
 * grok-reasoning.ts but with the union defined by the SDK, not by us.
 */
export function normalizeBubbleThinkingLevel(
  raw: string | null | undefined
): string | null {
  const trimmed = (raw || '').trim().toLowerCase();
  return (BUBBLE_THINKING_LEVELS as readonly string[]).includes(trimmed) ? trimmed : null;
}

export function bubbleThinkingLevelsForModel(
  models: BubbleModelConfig['availableModels'] | undefined,
  model: string | null | undefined
): string[] {
  const matched = (models ?? []).find((entry) => entry.name === model);
  return matched?.reasoningLevels ?? [];
}

/** Label for a thinking level (known tiers get hand labels, unknown pass through capitalized). */
export function formatBubbleThinkingLevelLabel(level: string): string {
  const trimmed = level.trim().toLowerCase();
  if (BUBBLE_THINKING_LEVEL_LABELS[trimmed]) {
    return BUBBLE_THINKING_LEVEL_LABELS[trimmed];
  }
  const raw = level.trim();
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function loadStoredPreferences(): Record<string, string> {
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
        .map(([model, level]) => [model, normalizeBubbleThinkingLevel(level)] as const)
        .filter((entry): entry is [string, string] => Boolean(entry[1]))
    );
  } catch {
    return {};
  }
}

function saveStoredPreferences(preferences: Record<string, string>): void {
  if (typeof window === 'undefined') {
    return;
  }

  rendererStateStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
}

export function loadPreferredBubbleThinkingLevel(model: string | null): string | null {
  if (!model) {
    return null;
  }

  return loadStoredPreferences()[model] || null;
}

export function savePreferredBubbleThinkingLevel(
  model: string | null,
  level: string
): void {
  if (!model || typeof window === 'undefined') {
    return;
  }

  const normalized = normalizeBubbleThinkingLevel(level);
  if (!normalized) {
    return;
  }

  const preferences = loadStoredPreferences();
  preferences[model] = normalized;
  saveStoredPreferences(preferences);
}

/**
 * Default resolution mirrors the SDK's variant-resolver rule so the
 * checked row matches what actually runs: user's saved per-model preference,
 * then the catalog's defaultReasoningLevel, then 'medium' when supported,
 * then the first tier. Models with no metadata (fallback tiers shown) get
 * null — nothing preselected, nothing sent; the SDK applies its own default.
 */
export function getDefaultBubbleThinkingLevel(
  models: BubbleModelConfig['availableModels'] | undefined,
  model: string | null
): string | null {
  if (!model) {
    return null;
  }

  const matched = (models ?? []).find((entry) => entry.name === model);
  const raw = matched?.reasoningLevels ?? [];
  if (raw.length === 0) {
    return null;
  }

  const preferred = loadPreferredBubbleThinkingLevel(model);
  if (preferred && raw.includes(preferred)) {
    return preferred;
  }

  const catalogDefault = normalizeBubbleThinkingLevel(matched?.defaultReasoningLevel);
  if (catalogDefault && raw.includes(catalogDefault)) {
    return catalogDefault;
  }

  return raw.includes('medium') ? 'medium' : raw[0];
}

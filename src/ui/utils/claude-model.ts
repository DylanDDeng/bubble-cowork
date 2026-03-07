import type { ClaudeModelConfig } from '../types';

const STORAGE_KEY = 'cowork.preferredClaudeModel';

export const CLAUDE_MODEL_PRESETS = ['sonnet', 'sonnet[1m]', 'opus', 'opus[1m]', 'haiku'];

export function loadPreferredClaudeModel(): string | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function savePreferredClaudeModel(model: string | null): void {
  if (typeof window === 'undefined') return;
  if (!model) {
    window.localStorage.removeItem(STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, model);
}

export function formatClaudeModelLabel(model: string): string {
  const normalized = model.trim();

  switch (model) {
    case 'haiku':
      return 'Haiku 4.5';
    case 'sonnet':
      return 'Sonnet 4.6';
    case 'sonnet[1m]':
      return 'Sonnet 4.6 (1M context)';
    case 'opus':
      return 'Opus 4.6';
    case 'opus[1m]':
      return 'Opus 4.6 (1M context)';
  }

  if (normalized.startsWith('claude-haiku-4-5')) {
    return 'Haiku 4.5';
  }

  if (normalized.startsWith('claude-sonnet-4-6')) {
    return normalized.includes('[1m]') ? 'Sonnet 4.6 (1M context)' : 'Sonnet 4.6';
  }

  if (normalized.startsWith('claude-opus-4-6')) {
    return normalized.includes('[1m]') ? 'Opus 4.6 (1M context)' : 'Opus 4.6';
  }

  return model;
}

export function buildClaudeModelOptions(
  config: ClaudeModelConfig,
  extraModels: Array<string | null | undefined> = []
): string[] {
  const normalizedExtras = extraModels
    .filter((value): value is string => Boolean(value && value.trim()))
    .map((value) => value.trim());

  const known = CLAUDE_MODEL_PRESETS.filter((value) =>
    [config.defaultModel, ...config.options, ...normalizedExtras].some((candidate) => candidate === value)
  );

  const unknown = [config.defaultModel, ...config.options, ...normalizedExtras].filter(
    (value): value is string => Boolean(value && value.trim() && !CLAUDE_MODEL_PRESETS.includes(value.trim()))
  );

  return Array.from(new Set([...known, ...CLAUDE_MODEL_PRESETS, ...unknown]));
}

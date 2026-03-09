import type { ClaudeModelConfig } from '../types';

const STORAGE_KEY = 'cowork.preferredClaudeModel';
const CONTEXT_1M_STORAGE_KEY = 'cowork.preferredClaudeContext1m';

export const CLAUDE_MODEL_PRESETS = ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5'];

export function canonicalizeClaudeModel(model: string | null | undefined): string | null {
  const normalized = model?.trim();
  if (!normalized) {
    return null;
  }

  switch (normalized) {
    case 'sonnet':
      return 'claude-sonnet-4-6';
    case 'opus':
      return 'claude-opus-4-6';
    case 'haiku':
      return 'claude-haiku-4-5';
    default:
      return normalized;
  }
}

export function loadPreferredClaudeModel(): string | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  return canonicalizeClaudeModel(raw);
}

export function savePreferredClaudeModel(model: string | null): void {
  if (typeof window === 'undefined') return;
  if (!model) {
    window.localStorage.removeItem(STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, canonicalizeClaudeModel(model) || model);
}

export function loadPreferredClaudeContext1m(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(CONTEXT_1M_STORAGE_KEY) === 'true';
}

export function savePreferredClaudeContext1m(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(CONTEXT_1M_STORAGE_KEY, enabled ? 'true' : 'false');
}

export function supportsClaude1mContext(model?: string | null): boolean {
  const normalized = model?.trim();
  return normalized === 'claude-sonnet-4-6' || normalized === 'claude-opus-4-6';
}

export function isOfficialClaudeModel(model?: string | null): boolean {
  const normalized = canonicalizeClaudeModel(model) || model?.trim() || '';
  return normalized.length > 0 && (CLAUDE_MODEL_PRESETS.includes(normalized) || normalized.startsWith('claude-'));
}

export function formatClaudeModelLabel(model: string, context1m = false): string {
  const normalized = model.trim();
  const suffix = context1m && supportsClaude1mContext(normalized) ? ' (1M context)' : '';

  switch (model) {
    case 'haiku':
    case 'claude-haiku-4-5':
      return 'Haiku 4.5';
    case 'sonnet':
    case 'claude-sonnet-4-6':
      return `Sonnet 4.6${suffix}`;
    case 'opus':
    case 'claude-opus-4-6':
      return `Opus 4.6${suffix}`;
  }

  if (normalized.startsWith('claude-haiku-4-5')) {
    return 'Haiku 4.5';
  }

  if (normalized.startsWith('claude-sonnet-4-6')) {
    return `Sonnet 4.6${suffix}`;
  }

  if (normalized.startsWith('claude-opus-4-6')) {
    return `Opus 4.6${suffix}`;
  }

  return model;
}

export function buildClaudeModelOptions(
  config: ClaudeModelConfig,
  extraModels: Array<string | null | undefined> = []
): string[] {
  const normalizedConfigValues = [config.defaultModel, ...config.options]
    .filter((value): value is string => Boolean(value && value.trim()))
    .map((value) => canonicalizeClaudeModel(value) || value.trim());
  const normalizedExtras = extraModels
    .filter((value): value is string => Boolean(value && value.trim()))
    .map((value) => canonicalizeClaudeModel(value) || value.trim());

  const known = CLAUDE_MODEL_PRESETS.filter((value) =>
    [...normalizedConfigValues, ...normalizedExtras].some((candidate) => candidate === value)
  );

  const unknown = [...normalizedConfigValues, ...normalizedExtras].filter(
    (value): value is string => Boolean(value && value.trim() && !CLAUDE_MODEL_PRESETS.includes(value.trim()))
  );

  return Array.from(new Set([...known, ...CLAUDE_MODEL_PRESETS, ...unknown]));
}

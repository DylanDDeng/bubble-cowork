import type { CodexModelConfig } from '../types';

const STORAGE_KEY = 'cowork.preferredCodexModel';

export function loadPreferredCodexModel(): string | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function savePreferredCodexModel(model: string | null): void {
  if (typeof window === 'undefined') return;
  if (!model) {
    window.localStorage.removeItem(STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, model);
}

export function formatCodexModelLabel(model: string): string {
  const normalized = model.trim();
  if (!normalized) return 'Codex model';

  return normalized
    .split('-')
    .map((part, index) => {
      if (index === 0) return part.toUpperCase();
      if (/^\d/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join('-')
    .replace(/-Codex/g, ' Codex')
    .replace(/-Spark/g, ' Spark')
    .replace(/-Mini/g, ' Mini')
    .replace(/-Max/g, ' Max');
}

export function buildCodexModelOptions(config: CodexModelConfig): string[] {
  return Array.from(
    new Set(
      [config.defaultModel, ...config.options].filter((value): value is string => Boolean(value))
    )
  );
}

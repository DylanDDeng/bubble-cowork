import type { OpenCodeModelConfig } from '../types';

const STORAGE_KEY = 'cowork.preferredOpencodeModel';

export function loadPreferredOpencodeModel(): string | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function savePreferredOpencodeModel(model: string | null): void {
  if (typeof window === 'undefined') return;
  if (!model) {
    window.localStorage.removeItem(STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, model);
}

export function formatOpencodeModelLabel(model: string): string {
  const normalized = model.trim();
  if (!normalized) return 'OpenCode model';
  return normalized.toLowerCase();
}

export function buildOpencodeModelOptions(config: OpenCodeModelConfig): string[] {
  return Array.from(new Set(config.options.filter((value): value is string => Boolean(value))));
}

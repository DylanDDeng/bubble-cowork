import type { CodexExecutionMode } from '../types';

const STORAGE_KEY = 'cowork.preferredCodexExecutionMode';

function normalizeCodexExecutionMode(
  raw: string | null | undefined
): CodexExecutionMode {
  return raw === 'plan' ? 'plan' : 'execute';
}

export function loadPreferredCodexExecutionMode(): CodexExecutionMode {
  if (typeof window === 'undefined') return 'execute';
  return normalizeCodexExecutionMode(window.localStorage.getItem(STORAGE_KEY));
}

export function savePreferredCodexExecutionMode(mode: CodexExecutionMode): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, mode);
}

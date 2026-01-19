import type { AgentProvider } from '../types';

export const PROVIDERS: Array<{ id: AgentProvider; label: string }> = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
];

const STORAGE_KEY = 'cowork.preferredProvider';

export function loadPreferredProvider(): AgentProvider {
  if (typeof window === 'undefined') return 'claude';
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return raw === 'codex' || raw === 'claude' ? raw : 'claude';
}

export function savePreferredProvider(provider: AgentProvider): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, provider);
}

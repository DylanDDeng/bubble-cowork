import type { AgentProvider } from '../types';

export const PROVIDERS: Array<{ id: AgentProvider; label: string }> = [
  { id: 'aegis', label: 'Aegis' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'kimi', label: 'Kimi Code' },
];

const STORAGE_KEY = 'cowork.preferredProvider';

export function loadPreferredProvider(): AgentProvider {
  if (typeof window === 'undefined') return 'claude';
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return raw === 'aegis' || raw === 'codex' || raw === 'opencode' || raw === 'kimi' || raw === 'claude'
    ? raw
    : 'claude';
}

export function savePreferredProvider(provider: AgentProvider): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, provider);
}

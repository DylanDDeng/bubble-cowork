import type { AgentProvider } from '../types';

export const PROVIDERS: Array<{ id: AgentProvider; label: string }> = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'kimi', label: 'Kimi Code' },
  { id: 'grok', label: 'Grok Build' },
  { id: 'pi', label: 'Pi' },
];

const STORAGE_KEY = 'cowork.preferredProvider';

export function loadPreferredProvider(): AgentProvider {
  if (typeof window === 'undefined') return 'claude';
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return raw === 'codex' || raw === 'opencode' || raw === 'kimi' || raw === 'claude' || raw === 'grok' || raw === 'pi'
    ? raw
    : 'claude';
}

export function savePreferredProvider(provider: AgentProvider): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, provider);
}

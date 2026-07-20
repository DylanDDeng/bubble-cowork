import { rendererStateStorage } from './renderer-state-storage';
import type { AgentProvider } from '../types';

export const PROVIDERS: Array<{ id: AgentProvider; label: string }> = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'kimi', label: 'Kimi Code' },
  { id: 'grok', label: 'Grok Build' },
  { id: 'pi', label: 'Pi' },
  { id: 'qoder', label: 'Qoder' },
];

const STORAGE_KEY = 'cowork.preferredProvider';

export function loadPreferredProvider(): AgentProvider {
  if (typeof window === 'undefined') return 'claude';
  const raw = rendererStateStorage.getItem(STORAGE_KEY);
  return raw === 'codex' || raw === 'opencode' || raw === 'kimi' || raw === 'claude' || raw === 'grok' || raw === 'pi' || raw === 'qoder'
    ? raw
    : 'claude';
}

export function savePreferredProvider(provider: AgentProvider): void {
  if (typeof window === 'undefined') return;
  rendererStateStorage.setItem(STORAGE_KEY, provider);
}

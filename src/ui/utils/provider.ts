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
  { id: 'bubble', label: 'Bubble' },
  { id: 'deepseek', label: 'DeepSeek Harness' },
  { id: 'devin', label: 'Devin' },
  { id: 'mimo', label: 'MiMo Code' },
];

const STORAGE_KEY = 'cowork.preferredProvider';

export function loadPreferredProvider(): AgentProvider {
  if (typeof window === 'undefined') return 'claude';
  const raw = rendererStateStorage.getItem(STORAGE_KEY);
  return raw === 'codex' || raw === 'opencode' || raw === 'kimi' || raw === 'claude' || raw === 'grok' || raw === 'pi' || raw === 'qoder' || raw === 'bubble' || raw === 'deepseek' || raw === 'devin' || raw === 'mimo'
    ? raw
    : 'claude';
}

export function savePreferredProvider(provider: AgentProvider): void {
  if (typeof window === 'undefined') return;
  rendererStateStorage.setItem(STORAGE_KEY, provider);
}

/** Fired when the preferred agent changes outside the composer (onboarding). */
export const PREFERRED_PROVIDER_EVENT = 'aegis:preferred-provider-changed';

/**
 * Persist the preferred agent and tell mounted new-session composers, which
 * read the preference only once on mount.
 */
export function announcePreferredProvider(provider: AgentProvider): void {
  savePreferredProvider(provider);
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<AgentProvider>(PREFERRED_PROVIDER_EVENT, { detail: provider }));
}

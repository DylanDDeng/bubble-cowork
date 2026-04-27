import type { RunnerHandle, RunnerOptions } from '../../types';

// Codex is now handled by ProviderService, not RuntimeRegistry
export type AgentRuntimeId = 'native' | 'claude' | 'opencode';

export interface AgentRuntime {
  id: AgentRuntimeId;
  displayName: string;
  run: (options: RunnerOptions) => RunnerHandle;
}

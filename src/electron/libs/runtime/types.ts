import type { RunnerHandle, RunnerOptions } from '../../types';

export type AgentRuntimeId = 'native' | 'claude' | 'opencode';

export interface AgentRuntime {
  id: AgentRuntimeId;
  displayName: string;
  run: (options: RunnerOptions) => RunnerHandle;
}

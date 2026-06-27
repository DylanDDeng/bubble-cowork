import { claudeRuntime } from './claude-runtime';
import { nativeRuntime } from './native-runtime';
import { opencodeRuntime } from './opencode-runtime';
import { registerRuntime } from './registry';

let initialized = false;

export function ensureAgentRuntimeRegistry(): void {
  if (initialized) {
    return;
  }
  registerRuntime(nativeRuntime);
  registerRuntime(claudeRuntime);
  registerRuntime(opencodeRuntime);
  initialized = true;
}

export { getAllRuntimes, getRuntime, resolveRuntime } from './registry';
export type { AgentRuntime, AgentRuntimeId } from './types';

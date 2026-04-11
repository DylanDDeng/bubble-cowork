import type { RunnerHandle, RunnerOptions } from '../types';
import { ensureAgentRuntimeRegistry, resolveRuntime } from './runtime';

export function runAgentLoop(options: RunnerOptions): RunnerHandle {
  ensureAgentRuntimeRegistry();
  const runtime = resolveRuntime(options.session.provider);
  return runtime.run(options);
}

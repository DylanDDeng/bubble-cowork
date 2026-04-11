import { runClaude } from '../runner';
import type { AgentRuntime } from './types';

export const claudeRuntime: AgentRuntime = {
  id: 'claude',
  displayName: 'Claude Agent SDK',
  run: runClaude,
};

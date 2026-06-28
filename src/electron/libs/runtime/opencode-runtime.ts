import { runOpenCode } from '../codex-runner';
import type { AgentRuntime } from './types';

export const opencodeRuntime: AgentRuntime = {
  id: 'opencode',
  displayName: 'OpenCode SDK',
  run: runOpenCode,
};

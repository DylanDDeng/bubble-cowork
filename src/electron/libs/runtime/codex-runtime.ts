import { runCodex } from '../codex-runner';
import type { AgentRuntime } from './types';

export const codexRuntime: AgentRuntime = {
  id: 'codex',
  displayName: 'Codex ACP',
  run: runCodex,
};

/**
 * Subagent lifecycle control: data structures, helpers, and host interface.
 */

export type SubagentStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'closed'
  | 'waiting_for_input';

export interface SubagentThreadSnapshot {
  id: string;
  nickname: string;
  task: string;
  profile: string;
  status: SubagentStatus;
  summary?: string;
  error?: string;
  usage?: { input: number; output: number };
  createdAt: number;
  completedAt?: number;
}

export interface SubagentThreadRecord {
  id: string;
  parentToolCallId: string;
  nickname: string;
  task: string;
  profile: string;
  category?: string;
  status: SubagentStatus;
  summary?: string;
  usage?: { input: number; output: number };
  error?: string;
  timeoutMs?: number;
  createdAt: number;
  completedAt?: number;
  abortController: AbortController;
  waiter?: () => void;

  /** Internal promise so we can block on completion when blocking=true. */
  _promise?: Promise<void>;

  asSnapshot(): SubagentThreadSnapshot;
}

export interface SpawnSubAgentParams {
  agentType: string;
  message: string;
  toolCallId?: string;
  category?: string;
  blocking?: boolean;
  timeoutMs?: number;
}

export interface BuiltinSubagentHost {
  spawnSubAgent(params: SpawnSubAgentParams): Promise<SubagentThreadSnapshot>;
  closeSubAgent(agentId: string): SubagentThreadSnapshot | null;
  sendSubAgentInput(
    agentId: string,
    message: string,
    interrupt?: boolean
  ): SubagentThreadSnapshot | null;
  waitForAgentStop(
    agentId?: string,
    timeoutMs?: number
  ): Promise<SubagentThreadSnapshot[]>;
  getSubagentSnapshots(): SubagentThreadSnapshot[];
  activeSubagentNicknames(): string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Famous computer scientists — matches my-coding-agent's DEFAULT_NICKNAME_CANDIDATES. */
const NICKNAME_CANDIDATES: string[] = [
  'Alan', 'Grace', 'Donald', 'Ada', 'Linus', 'Dennis',
  'Bjarne', 'Margaret', 'John', 'Barbara', 'Edgar', 'Claude',
  'Katherine', 'Frances', 'Herbert', 'Seymour', 'Geoffrey', 'Yann',
  'Fei-Fei', 'Yoshua', 'Andrew', 'Ken', 'Tim', 'Leslie',
];

export function assignAgentNickname(
  profile: string,
  existingNames: string[]
): string {
  const existing = new Set(existingNames);

  // Pick a random unused candidate name
  const available = NICKNAME_CANDIDATES.filter((n) => !existing.has(n));
  if (available.length > 0) {
    return available[Math.floor(Math.random() * available.length)];
  }

  // Fallback: all candidates taken
  let idx = 1;
  while (existing.has(`${profile}-${idx}`)) idx += 1;
  return `${profile}-${idx}`;
}

export function isFinalSubagentStatus(status: SubagentStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'closed'
  );
}

export function formatAnthropicUsage(usage: {
  input: number;
  output: number;
}): string {
  return `input=${usage.input} output=${usage.output}`;
}

export function subagentResultContent(
  status: SubagentStatus,
  summary?: string,
  error?: string
): string {
  if (status === 'completed' && summary) {
    return `Subagent completed successfully.\n\n${summary}`;
  }
  if (status === 'failed' && error) {
    return `Subagent failed: ${error}`;
  }
  if (status === 'cancelled') {
    return 'Subagent was cancelled.';
  }
  if (status === 'closed') {
    return 'Subagent was closed.';
  }
  return `Subagent status: ${status}`;
}

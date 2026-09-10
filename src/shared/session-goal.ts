import type { CodexPermissionMode, CodexReasoningEffort } from './types';

/** Codex app-server's native goal contract; status and counters are server-owned. */
export type ThreadGoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'usageLimited'
  | 'budgetLimited'
  | 'complete';
export interface ThreadGoal {
  /** Claude reports evaluation checks, not Codex's budget/time accounting. */
  claude?: { iterations: number; lastReason?: string };
  /** UI-only expanded text for app-owned file-backed objectives. */
  displayObjective?: string;
  threadId: string;
  objective: string;
  status: ThreadGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}
export type GoalAction =
  | { type: 'set'; objective?: string; status?: 'active' | 'paused'; tokenBudget?: number | null }
  | { type: 'clear' };
export interface GoalSettings {
  appendTranscript?: boolean;
  model?: string;
  claudeAccessMode?: import('./types').ClaudeAccessMode;
  claudeReasoningEffort?: import('./types').ClaudeReasoningEffort;
  codexPermissionMode?: CodexPermissionMode;
  codexReasoningEffort?: CodexReasoningEffort;
  codexFastMode?: boolean;
}

export function supportsGoalUI(provider?: string): boolean {
  return provider === 'codex' || provider === 'claude';
}

export function isClaudeGoalClearObjective(value: string): boolean {
  return ['clear', 'stop', 'off', 'reset', 'none', 'cancel'].includes(value.trim().toLowerCase());
}
export interface SessionGoalSnapshot {
  sessionId: string;
  supported: boolean;
  goal: ThreadGoal | null;
  completedGoal?: ThreadGoal | null;
  resumeConfirmation?: boolean;
  revision: number;
}

export function validateGoalAction(value: GoalAction): GoalAction {
  if (value?.type === 'clear') return { type: 'clear' };
  if (value?.type !== 'set') throw new Error('Invalid goal action.');
  if (
    value.objective !== undefined &&
    (typeof value.objective !== 'string' || !value.objective.trim())
  ) {
    throw new Error('Enter a goal to pursue.');
  }
  if (value.status !== undefined && !['active', 'paused'].includes(value.status))
    throw new Error('Invalid goal status.');
  if (
    value.tokenBudget != null &&
    (!Number.isSafeInteger(value.tokenBudget) || value.tokenBudget <= 0)
  ) {
    throw new Error('Token budget must be a positive integer.');
  }
  if (
    value.objective === undefined &&
    value.status === undefined &&
    value.tokenBudget === undefined
  )
    throw new Error('No goal change provided.');
  return {
    type: 'set',
    ...(value.objective !== undefined ? { objective: value.objective.trim() } : {}),
    ...(value.status !== undefined ? { status: value.status } : {}),
    ...(value.tokenBudget !== undefined ? { tokenBudget: value.tokenBudget } : {}),
  };
}

export function goalStatusLabel(status: ThreadGoalStatus): string {
  return {
    active: 'Pursuing goal',
    paused: 'Paused goal',
    blocked: 'Goal stalled',
    usageLimited: 'Goal usage limited',
    budgetLimited: 'Goal limited',
    complete: 'Goal achieved',
  }[status];
}

export function goalCanResume(status: ThreadGoalStatus): boolean {
  return status === 'paused' || status === 'blocked' || status === 'usageLimited';
}

export function parseGoalInput(
  prompt: string,
  drafting: boolean,
): { isGoal: boolean; objective: string } {
  const match = /^\s*\/goal(?:\s+([\s\S]*))?$/i.exec(prompt);
  return { isGoal: drafting || !!match, objective: (match ? match[1] || '' : prompt).trim() };
}

/** Attachments are app-managed absolute paths, retained for later native turns. */
export function buildGoalObjective(
  objective: string,
  attachments: Array<{ name: string; path: string }> = [],
): string {
  return [
    objective.trim(),
    attachments.length
      ? 'Goal attachments:\n' + attachments.map((file) => `- ${file.name}: ${file.path}`).join('\n')
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

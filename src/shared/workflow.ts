// Types shared by the main process and the renderer for app-level agent
// workflows (docs/collaboration/README.md).

export type WorkflowMemberRole = 'implementer' | 'reviewer' | 'advisor' | 'planner';

/** Runtime policy a workflow imposes on one member session (plan §6.3). */
export type WorkflowSessionPolicy = {
  runId: string;
  role: WorkflowMemberRole;
  /** reviewer / advisor / planner: no file writes, no commands, no writable MCP. */
  readOnly: boolean;
};

export type WorkflowRunStatus =
  | 'planning'
  | 'awaiting_confirmation'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'needs_input'
  | 'succeeded'
  | 'completed_with_gaps'
  | 'interrupted'
  | 'cancelling'
  | 'cancelled'
  | 'failed';

export type WorkflowLocation = 'current' | 'isolated';

/**
 * Member configuration name for the chat session that started a workflow
 * from its conversation: it takes part as itself (its own provider, model,
 * permission mode and history) instead of a new member session.
 */
export const CURRENT_SESSION_AGENT = 'current';

/** App tool a chat session calls to hand a request to the workflow engine. */
export const START_WORKFLOW_TOOL = 'start_workflow';

export function isStartWorkflowToolName(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  const normalized = name.trim().toLowerCase();
  return (
    normalized === START_WORKFLOW_TOOL ||
    normalized.endsWith(`__${START_WORKFLOW_TOOL}`) ||
    normalized.endsWith(`.${START_WORKFLOW_TOOL}`) ||
    normalized.endsWith(`/${START_WORKFLOW_TOOL}`)
  );
}

/**
 * The chat session (and its tool call) a workflow was started from.
 * `fullAccess`: that session ran with full access when it asked, so the
 * workflow's commands need no separate approval either.
 */
export type WorkflowParent = { sessionId: string; toolUseId: string | null; provider: string; fullAccess?: boolean };

/** Each provider's "run anything without asking" permission mode. */
const FULL_ACCESS_MODES: Record<string, string[]> = {
  claude: ['bypassPermissions', 'fullAccess'],
  codex: ['fullAccess'],
  opencode: ['fullAccess'],
  kimi: ['yolo'],
  grok: ['yolo'],
  deepseek: ['danger-full-access'],
  devin: ['bypass'],
  bubble: ['bypassPermissions'],
  qoder: ['bypassPermissions'],
};

export function isFullAccessMode(provider: string, mode: string | null | undefined): boolean {
  return Boolean(mode && FULL_ACCESS_MODES[provider]?.includes(mode));
}

export type WorkflowMemberView = {
  key: string;
  role: 'implementer' | 'reviewer' | 'advisor';
  agent: string;
  provider: string;
  model: string | null;
  focus: string | null;
  source: 'user' | 'template' | 'inferred';
  permissionMode: string | null;
  permissionModeIsDefault: boolean;
  readOnlyMechanism: string | null;
  degraded: string[];
  unverified: boolean;
  currentSessionId: string | null;
};

export type WorkflowStepView = {
  /** Instance key once it has run; step id for steps not yet reached. */
  key: string;
  stepId: string;
  kind: 'agent' | 'check' | 'ask' | 'stop';
  phase: string | null;
  label: string;
  memberKey: string | null;
  iteration: number[] | null;
  /** Container path for grouping, e.g. ["build.rounds[1]"]. */
  group: string | null;
  state: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'needs_input';
  sessionId: string | null;
  version: string | null;
  summary: string | null;
  verdict: string | null;
};

export type WorkflowCheckView = {
  stepId: string;
  argv: string[];
  authorization: 'auto' | 'confirm';
  basis: string | null;
  highlight: boolean;
  reasons: string[];
};

export type WorkflowAcceptanceView = {
  id: string;
  description: string;
  kind: 'check' | 'review' | 'manual';
  source: 'user' | 'template' | 'inferred';
  status: 'pending' | 'satisfied' | 'unsatisfied' | 'manual' | 'waived';
};

export type WorkflowNeedsInput = {
  reason: string;
  detail: string | null;
  instanceKey: string | null;
  stepId: string | null;
  question: string | null;
  options: Array<{ id: string; label: string }>;
};

export type WorkflowRunView = {
  id: string;
  title: string;
  goal: string;
  cwd: string;
  location: WorkflowLocation;
  status: WorkflowRunStatus;
  revision: number;
  createdAt: number;
  updatedAt: number;
  description: string | null;
  members: WorkflowMemberView[];
  acceptance: WorkflowAcceptanceView[];
  checks: WorkflowCheckView[];
  unsupported: string[];
  assumptions: string[];
  warnings: string[];
  confirmReasons: string[];
  steps: WorkflowStepView[];
  needsInput: WorkflowNeedsInput | null;
  error: string | null;
  finalVersion: string | null;
  plannerSessionId: string | null;
  isolated: { worktreePath: string; branch: string; implementerSessionId: string | null } | null;
  /** Instance keys of skipped steps and other transient UI state. */
  includesUserChanges: boolean;
  /** The workflow definition (tree form), for "view workflow JSON". */
  spec: import('../workflow-engine/spec/workflow-spec').WorkflowSpec | null;
  /** Set when a chat session started this workflow; its conversation shows the run. */
  parent: WorkflowParent | null;
};

export type WorkflowStartRequest = {
  requestId: string;
  goal: string;
  cwd: string;
  /** Composer permission mode per provider, resolved in the renderer (plan §3.2). */
  permissionModes: Record<string, string>;
  /** Providers the composer offers on this machine; the planner may only use these. */
  availableAgents: string[];
  plannerAgent?: string | null;
  location?: WorkflowLocation | null;
  /** Skip the planner and use a built-in template with these members. */
  template?: WorkflowTemplateRequest | null;
  /**
   * Skip the planner and run this workflow definition (tree form, validated
   * like any planned workflow). Used by repository workflows and conformance runs.
   */
  spec?: import('../workflow-engine/spec/workflow-spec').WorkflowSpec | null;
  /** Always stop at the plan card, even when nothing needs confirmation. */
  planOnly?: boolean;
  /** The chat session asking for this workflow; it can take part as the "current" member. */
  parent?: WorkflowParent | null;
};

export type WorkflowTemplateRequest = {
  kind: 'implement-review';
  implementer: string;
  reviewers: Array<{ agent: string; focus?: string }>;
  checks?: string[][];
  maxRepairRounds?: number;
};

export type WorkflowAction =
  | { type: 'confirm'; runId: string; expectedRevision: number; location?: WorkflowLocation }
  | { type: 'answer'; runId: string; expectedRevision: number; optionId?: string; text?: string }
  | { type: 'pause'; runId: string; expectedRevision: number }
  | { type: 'resume'; runId: string; expectedRevision: number }
  | { type: 'cancel'; runId: string; expectedRevision: number }
  | { type: 'archive'; runId: string }
  | { type: 'verify-manual'; runId: string; acceptanceId: string }
  | { type: 'waive'; runId: string; acceptanceId: string }
  | { type: 'apply-isolated'; runId: string }
  | { type: 'discard-isolated'; runId: string };

export type WorkflowActionResult = { ok: true; run: WorkflowRunView } | { ok: false; error: string; run?: WorkflowRunView };

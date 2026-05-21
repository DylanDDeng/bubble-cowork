import type { BuiltinToolRegistryEntry, BuiltinToolResultStatus } from '../types';

// Tools a subagent must never receive, regardless of profile or policy
const SUBAGENT_FORBIDDEN_TOOLS = new Set([
  'spawn_agent', 'wait_agent', 'send_input', 'close_agent',
  'task', 'delegate', 'exit_plan_mode',
]);

// ── Subagent tool profiles (matches my-coding-agent's builtinAgentProfiles) ──

/** Full read-only tool set for the `default` profile. */
const DEFAULT_PROFILE: ReadonlySet<string> = new Set([
  'read', 'glob', 'grep', 'lsp',
  'web_search', 'web_fetch',
  'skill', 'skill_read', 'skill_read_resource',
  'todo_write', 'tool_search',
  'memory_search', 'memory_read_summary',
  'question',
]);

/** Explorer / worker profile — no external web tools. */
const EXPLORER_WORKER_PROFILE: ReadonlySet<string> = new Set([
  'read', 'glob', 'grep', 'lsp',
  'skill', 'skill_read', 'skill_read_resource',
  'todo_write', 'tool_search',
  'memory_search', 'memory_read_summary',
]);

const SUBAGENT_TOOL_PROFILES: Record<string, ReadonlySet<string>> = {
  default: DEFAULT_PROFILE,
  explorer: EXPLORER_WORKER_PROFILE,
  'explorer/review': EXPLORER_WORKER_PROFILE,
  worker: EXPLORER_WORKER_PROFILE,
};

/**
 * Select tools for a subagent profile.
 * - Starts from the profile preset (or default if unknown).
 * - Removes all forbidden lifecycle and delegation tools.
 * - Safety gate: only keeps tools marked `readOnly: true`.
 */
export function selectToolsForProfile(
  tools: BuiltinToolRegistryEntry[],
  profile: string,
): BuiltinToolRegistryEntry[] {
  const allowedSet = SUBAGENT_TOOL_PROFILES[profile] ?? DEFAULT_PROFILE;
  return tools.filter((t) => {
    if (SUBAGENT_FORBIDDEN_TOOLS.has(t.name)) return false;
    if (!allowedSet.has(t.name)) return false;
    if (!t.readOnly) return false;
    return true;
  });
}

export type BuiltinSubtaskType =
  | 'search'
  | 'security_investigation'
  | 'evidence_correlation'
  | 'general_readonly';

export interface BuiltinSubtaskPolicy {
  type: BuiltinSubtaskType;
  allowedTools: string[];
  reminder: string;
  resultStatus: BuiltinToolResultStatus;
  maxTurns?: number;
}

const POLICY_MAP: Record<BuiltinSubtaskType, BuiltinSubtaskPolicy> = {
  search: {
    type: 'search',
    allowedTools: ['read', 'glob', 'grep', 'lsp', 'web_search', 'web_fetch', 'skill', 'skill_read', 'skill_read_resource', 'todo_write', 'tool_search'],
    reminder: [
      'Subtask policy: search',
      '- Focus on locating relevant files, symbols, and evidence quickly.',
      '- Use glob for file discovery, grep for content search, lsp for code navigation, and web tools for current external facts.',
      '- Return a concise summary of what you found and where.',
      '- Stop by giving a final answer when the scoped evidence is found or clearly absent.',
    ].join('\n'),
    resultStatus: 'success',
  },
  security_investigation: {
    type: 'security_investigation',
    allowedTools: ['read', 'glob', 'grep', 'lsp', 'web_search', 'web_fetch', 'skill', 'skill_read', 'skill_read_resource', 'todo_write', 'tool_search'],
    reminder: [
      'Subtask policy: security_investigation',
      '- Investigate only in read-only mode.',
      '- Collect evidence about config load paths, environment reads, persistence paths, masking, and exposure paths.',
      '- Do not loop on broad keyword search; summarize evidence and uncertainty.',
      '- Stop by giving a final answer when the scoped evidence is found or clearly absent.',
    ].join('\n'),
    resultStatus: 'success',
  },
  evidence_correlation: {
    type: 'evidence_correlation',
    allowedTools: ['read', 'lsp', 'skill', 'skill_read', 'skill_read_resource', 'todo_write', 'tool_search'],
    reminder: [
      'Subtask policy: evidence_correlation',
      '- Correlate evidence already discovered.',
      '- Avoid new broad searches; read only the specific files that matter.',
      '- Produce a reasoning-focused summary that states what the evidence supports.',
      '- Stop by giving a final answer when the scoped evidence is found or clearly absent.',
    ].join('\n'),
    resultStatus: 'success',
  },
  general_readonly: {
    type: 'general_readonly',
    allowedTools: ['read', 'glob', 'grep', 'lsp', 'web_search', 'web_fetch', 'skill', 'skill_read', 'skill_read_resource', 'todo_write', 'tool_search'],
    reminder: [
      'Subtask policy: general_readonly',
      '- Stay in read-only mode.',
      '- Keep the scope tightly bounded and summarize findings concisely.',
      '- Stop by giving a final answer when the scoped evidence is found or clearly absent.',
    ].join('\n'),
    resultStatus: 'success',
  },
};

export function getSubtaskPolicy(type: BuiltinSubtaskType | undefined): BuiltinSubtaskPolicy {
  return POLICY_MAP[type ?? 'general_readonly'];
}

export function filterToolsForSubtask(
  tools: BuiltinToolRegistryEntry[],
  type: BuiltinSubtaskType | undefined,
  profile?: string,
): BuiltinToolRegistryEntry[] {
  // Profile-based filtering takes priority when specified
  if (profile) {
    return selectToolsForProfile(tools, profile);
  }

  // Legacy policy-based fallback
  const policy = getSubtaskPolicy(type);
  return tools.filter((tool) => tool.name !== 'task' && policy.allowedTools.includes(tool.name));
}

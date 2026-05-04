import type { BuiltinToolRegistryEntry, BuiltinToolResultStatus } from '../types';

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
  maxTurns: number;
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
    ].join('\n'),
    resultStatus: 'success',
    maxTurns: 6,
  },
  security_investigation: {
    type: 'security_investigation',
    allowedTools: ['read', 'glob', 'grep', 'lsp', 'web_search', 'web_fetch', 'skill', 'skill_read', 'skill_read_resource', 'todo_write', 'tool_search'],
    reminder: [
      'Subtask policy: security_investigation',
      '- Investigate only in read-only mode.',
      '- Collect evidence about config load paths, environment reads, persistence paths, masking, and exposure paths.',
      '- Do not loop on broad keyword search; summarize evidence and uncertainty.',
    ].join('\n'),
    resultStatus: 'success',
    maxTurns: 8,
  },
  evidence_correlation: {
    type: 'evidence_correlation',
    allowedTools: ['read', 'lsp', 'skill', 'skill_read', 'skill_read_resource', 'todo_write', 'tool_search'],
    reminder: [
      'Subtask policy: evidence_correlation',
      '- Correlate evidence already discovered.',
      '- Avoid new broad searches; read only the specific files that matter.',
      '- Produce a reasoning-focused summary that states what the evidence supports.',
    ].join('\n'),
    resultStatus: 'success',
    maxTurns: 4,
  },
  general_readonly: {
    type: 'general_readonly',
    allowedTools: ['read', 'glob', 'grep', 'lsp', 'web_search', 'web_fetch', 'skill', 'skill_read', 'skill_read_resource', 'todo_write', 'tool_search'],
    reminder: [
      'Subtask policy: general_readonly',
      '- Stay in read-only mode.',
      '- Keep the scope tightly bounded and summarize findings concisely.',
    ].join('\n'),
    resultStatus: 'success',
    maxTurns: 6,
  },
};

export function getSubtaskPolicy(type: BuiltinSubtaskType | undefined): BuiltinSubtaskPolicy {
  return POLICY_MAP[type ?? 'general_readonly'];
}

export function filterToolsForSubtask(
  tools: BuiltinToolRegistryEntry[],
  type: BuiltinSubtaskType | undefined
): BuiltinToolRegistryEntry[] {
  const policy = getSubtaskPolicy(type);
  return tools.filter((tool) => tool.name !== 'task' && policy.allowedTools.includes(tool.name));
}

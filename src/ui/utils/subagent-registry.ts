/**
 * Derives the list of TOP-LEVEL subagents (Task tool calls the main agent
 * issued) for the current session, from `session.messages`. This is the data
 * source for the subagent detail panel's list and the environment panel's
 * subagent index — both are per-session and re-derived from messages, so they
 * stay correct across streaming, rewind (a rewound-away Task simply drops out
 * of the list), and session switches, with no separate mutable state.
 *
 * Only top-level subagents are listed: a subagent's own nested sub-Tasks
 * appear INSIDE that subagent's transcript, not as separate entries here.
 * "Top-level" = a Task tool_use block that appears in a main-agent message
 * (one whose `parentToolUseId` is null/absent).
 */
import type { ContentBlock, StreamMessage, ToolStatus } from '../types';
import { getMessageContentBlocks, normalizeToolUseBlock, normalizeToolResultBlock } from './message-content';
import { classifyToolUse } from './tool-summary';
import { groupSubagentMessagesByParent } from './workstream';
import { getSubagentPersona, type SubagentPersona } from './subagent-persona';

export interface SubagentSummary {
  /** parentToolUseId — the Task tool_use id; the stable per-session key. */
  id: string;
  subagentType: string | null;
  description: string | null;
  status: ToolStatus;
  /** Earliest child-message timestamp; anchors a live elapsed timer. */
  startedAt?: number;
  /** Wall-clock duration once the Task resolved. */
  durationMs?: number;
  /** Count of child messages (rough activity indicator for the list). */
  childMessageCount: number;
  persona: SubagentPersona;
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function isTaskBlock(block: ContentBlock): boolean {
  const normalized = normalizeToolUseBlock(block);
  if (!normalized) return false;
  return classifyToolUse(normalized.name, normalized.input) === 'subagent';
}

/** tool_use id → success/error from its matching tool_result (else pending). */
function buildTaskStatusMap(messages: StreamMessage[]): Map<string, ToolStatus> {
  const status = new Map<string, ToolStatus>();
  for (const message of messages) {
    if (message.type !== 'assistant' && message.type !== 'user') continue;
    for (const block of getMessageContentBlocks(message)) {
      const use = normalizeToolUseBlock(block);
      if (use) {
        if (!status.has(use.id)) status.set(use.id, 'pending');
        continue;
      }
      const result = normalizeToolResultBlock(block);
      if (result) {
        status.set(result.tool_use_id, result.is_error ? 'error' : 'success');
      }
    }
  }
  return status;
}

export function deriveSubagentSummaries(messages: StreamMessage[]): SubagentSummary[] {
  if (!messages.length) return [];

  const statusMap = buildTaskStatusMap(messages);
  const messagesByParent = groupSubagentMessagesByParent(messages);
  const summaries: SubagentSummary[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    if (message.type !== 'assistant') continue;
    // Top-level only: Task blocks issued by a SUBagent (parentToolUseId set)
    // are that subagent's nested work, shown inside its transcript.
    if (message.parentToolUseId) continue;

    for (const block of getMessageContentBlocks(message)) {
      if (!isTaskBlock(block)) continue;
      const use = normalizeToolUseBlock(block);
      if (!use || seen.has(use.id)) continue;
      seen.add(use.id);

      const input = (use.input && typeof use.input === 'object' ? use.input : {}) as Record<string, unknown>;
      const subagentType = getString(input.subagent_type);
      const description =
        getString(input.description) ||
        (getString(input.prompt) ? getString(input.prompt)!.slice(0, 200) : null);

      const status = statusMap.get(use.id) ?? 'pending';
      const childMessages = messagesByParent.get(use.id) ?? [];

      let minTs = Number.POSITIVE_INFINITY;
      let maxTs = Number.NEGATIVE_INFINITY;
      for (const child of childMessages) {
        const ts = (child as { createdAt?: unknown }).createdAt;
        if (typeof ts !== 'number' || !Number.isFinite(ts)) continue;
        if (ts < minTs) minTs = ts;
        if (ts > maxTs) maxTs = ts;
      }
      const finished = status === 'success' || status === 'error';
      const startedAt = Number.isFinite(minTs) ? minTs : undefined;
      const durationMs =
        finished && Number.isFinite(minTs) && Number.isFinite(maxTs) && maxTs >= minTs
          ? maxTs - minTs
          : undefined;

      summaries.push({
        id: use.id,
        subagentType,
        description,
        status,
        startedAt,
        durationMs,
        childMessageCount: childMessages.length,
        persona: getSubagentPersona(use.id, subagentType, description),
      });
    }
  }

  return summaries;
}

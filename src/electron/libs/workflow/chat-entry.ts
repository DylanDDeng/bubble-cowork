// In-chat entry (plan §8): a chat session hands a request that involves other
// agents to the workflow engine through the `start_workflow` app tool. The
// session only submits the request; the Planner turns it into a declarative
// workflow and the engine runs it. The call returns at once and the outcome
// comes back to the session as a follow-up turn.

import { z } from 'zod';
import { isStartWorkflowToolName } from '../../../shared/workflow';
import type { StreamMessage } from '../../types';

export const START_WORKFLOW_DESCRIPTION = [
  'Hand a request that involves other coding agents to the Aegis workflow engine, for example',
  '"have DeepSeek review your changes" or "let Codex implement this and Claude review it".',
  'The app plans the workflow, runs the other agents and shows their progress in this conversation.',
  'If the workflow needs fixes from you, they arrive as follow-up messages; do them and reply as asked.',
  'The call returns immediately. The result arrives as a follow-up message when the workflow ends,',
  'so end your turn after calling it: do not wait, poll, or do the other agents\' work yourself.',
  'Use it only when the user asks for other agents to take part.',
].join(' ');

/**
 * Standing instruction for chat sessions that have the tool. Without it an
 * agent asked to "have Codex review this" tends to run that agent's CLI
 * itself, which bypasses the workflow's roles, read-only guarantees and UI.
 */
export const WORKFLOW_CHAT_INSTRUCTIONS = [
  'Aegis can run other coding agents (for example Codex, Claude, Kimi, DeepSeek, Grok, Devin, Bubble) together with you as a workflow.',
  'When the user asks another agent to do something, such as reviewing your changes, implementing, investigating or checking work,',
  'call the start_workflow tool of the aegis-sessions MCP server (mcp__aegis-sessions__start_workflow) with the request.',
  "Do not run another agent's command-line tool yourself (for example `codex review`, `codex exec`, `claude -p`, `kimi`) and do not do their part yourself.",
  'After calling start_workflow, end your turn. The workflow shows its progress in this chat; tasks for you and its result arrive as follow-up messages.',
].join(' ');

export const startWorkflowSchema = {
  request: z
    .string()
    .min(1)
    .describe("The user's request, self-contained and in the user's words (which agents, what they should do)."),
  context: z
    .string()
    .optional()
    .describe('What the other agents need to know from this conversation, such as a summary of the changes you made.'),
};

export type StartWorkflowArgs = { request: string; context?: string };

type ToolText = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

export type WorkflowChatEntry = (call: StartWorkflowArgs & { callerSessionId: string | null }) => Promise<
  { ok: true; runId: string; text: string } | { ok: false; error: string }
>;

let entry: WorkflowChatEntry | null = null;

export function setWorkflowChatEntry(handler: WorkflowChatEntry | null): void {
  entry = handler;
}

/** Tool handler shared by the in-process (Claude) and HTTP session MCP servers. */
export async function startWorkflowTool(callerSessionId: string | null, args: StartWorkflowArgs): Promise<ToolText> {
  if (!entry) return { content: [{ type: 'text', text: 'Workflows are not available right now.' }], isError: true };
  try {
    const result = await entry({ ...args, callerSessionId });
    return result.ok
      ? { content: [{ type: 'text', text: result.text }] }
      : { content: [{ type: 'text', text: result.error }], isError: true };
  } catch (error) {
    return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function contentBlocks(message: StreamMessage): Record<string, unknown>[] {
  const content = asRecord((message as unknown as Record<string, unknown>).message)?.content;
  return Array.isArray(content) ? content.filter((b): b is Record<string, unknown> => asRecord(b) !== null) : [];
}

/**
 * The tool_use block a start_workflow call belongs to: the latest unanswered
 * call in the session's top-level history with the same request. HTTP MCP
 * calls carry no caller identity, so this is also how they are attributed.
 */
export function findPendingStartWorkflowCall(
  history: StreamMessage[],
  request: string,
  claimed: ReadonlySet<string>,
): string | null {
  const resolved = new Set<string>();
  const candidates: string[] = [];
  for (const message of history) {
    if ((message as { parentToolUseId?: string | null }).parentToolUseId) continue;
    if (message.type === 'assistant') {
      for (const block of contentBlocks(message)) {
        if (block.type !== 'tool_use' || !isStartWorkflowToolName(block.name)) continue;
        if (asRecord(block.input)?.request !== request) continue;
        if (typeof block.id === 'string' && block.id) candidates.push(block.id);
      }
    } else if (message.type === 'user') {
      for (const block of contentBlocks(message)) {
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') resolved.add(block.tool_use_id);
      }
    }
  }
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    if (!resolved.has(candidates[i]) && !claimed.has(candidates[i])) return candidates[i];
  }
  return null;
}

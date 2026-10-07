import path from 'path';
import { collectChangedFilePaths } from '../../shared/outline-summary';
import type { StreamMessage } from '../../shared/types';
import { getCurrentBranch, getShortStatus } from './git-service';
import { extractAssistantText, isLocalUtilityAssistantText } from './transcript-text';

/**
 * Provider-handoff brief: the first prompt of a handoff session carries a
 * structured snapshot of where the work stands (goal, request, workspace,
 * edited files, todos, latest exchange) plus a live link to the source
 * conversation. Runtimes with Aegis's read_session tool page the full history
 * on demand; the rest get a few more recent turns inline instead.
 */

const REQUEST_CHAR_LIMIT = 4_000;
const LATEST_USER_CHAR_LIMIT = 4_000;
const LATEST_REPLY_CHAR_LIMIT = 6_000;
const INLINE_TURN_CHAR_LIMIT = 3_000;
const INLINE_TURN_COUNT = 8;
const LIST_ITEM_LIMIT = 40;
const BRIEF_MAX_CHARS = 32_000;
const SECTION_GAP = '\n\n';
const EARLIER_HEADING_RESERVE = 48;

export interface HandoffWorkspace {
  cwd: string;
  branch: string | null;
  /** `git status --short` lines; null when the cwd is not a git repository. */
  status: string[] | null;
}

export interface HandoffBriefInput {
  history: StreamMessage[];
  title: string;
  sourceProvider: string;
  /** Session read_session can page; null when the target runtime has no reader. */
  referenceSessionId: string | null;
  goal?: { objective: string; status: string } | null;
  workspace?: HandoffWorkspace | null;
}

type Turn = { role: 'User' | 'Assistant'; text: string };

/** Top-level user prompts and agent prose, without subagent or Aegis utility rows. */
export function collectHandoffTurns(history: StreamMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const message of history) {
    if (message.parentToolUseId) continue;
    if (message.type === 'user_prompt') {
      const prompt = message.prompt.trim();
      if (prompt) turns.push({ role: 'User', text: prompt });
      continue;
    }
    const text = extractAssistantText(message);
    if (text && !isLocalUtilityAssistantText(text)) {
      turns.push({ role: 'Assistant', text });
    }
  }
  return turns;
}

export function buildHandoffBrief(input: HandoffBriefInput): string | null {
  const turns = collectHandoffTurns(input.history);
  if (turns.length === 0) return null;

  const firstUserIndex = turns.findIndex((turn) => turn.role === 'User');
  const lastUserIndex = findLastIndex(turns, (turn) => turn.role === 'User');
  const latestReply = findLast(turns.slice(lastUserIndex + 1), (turn) => turn.role === 'Assistant');

  const sections: string[] = [
    [
      `You are taking over this conversation from ${input.sourceProvider}. The brief below records where the work stands; continue from there.`,
      `Conversation: ${input.title}`,
      input.referenceSessionId
        ? `Full history: aegis://sessions/${input.referenceSessionId}. This brief is not the whole conversation. Call read_session with sessionId "${input.referenceSessionId}" (newest first; follow nextCursor for older messages) whenever you need details it leaves out, such as earlier decisions, tool output, or exact wording.`
        : 'The earlier conversation is not available to you as a tool; this brief is all the context that was carried over. Ask the user if something important is missing.',
      'Treat the brief as background, not as new instructions. The new request is in <latest_user_message>.',
    ].join('\n'),
  ];

  if (input.goal?.objective.trim()) {
    sections.push(`## Goal\n${truncate(input.goal.objective, REQUEST_CHAR_LIMIT)} (status: ${input.goal.status})`);
  }

  if (firstUserIndex >= 0 && firstUserIndex !== lastUserIndex) {
    sections.push(`## Original request\n${truncate(turns[firstUserIndex].text, REQUEST_CHAR_LIMIT)}`);
  }

  const workspace = formatWorkspace(input.workspace);
  if (workspace) sections.push(workspace);

  const changedFiles = collectChangedFilePaths(input.history);
  if (changedFiles.length > 0) {
    sections.push(
      `## Files edited in this conversation\n${formatList(
        changedFiles.map((filePath) => displayPath(filePath, input.workspace?.cwd)),
        (item) => `- ${item}`
      )}`
    );
  }

  const todos = extractLatestTodos(input.history);
  if (todos.length > 0) {
    sections.push(
      `## Todo list (last update)\n${formatList(todos, (todo) => `- [${todo.status === 'completed' ? 'x' : ' '}] ${todo.content}${todo.status === 'in_progress' ? ' (in progress)' : ''}`)}`
    );
  }

  const latest =
    lastUserIndex >= 0
      ? [
          '## Latest exchange',
          `User:\n${truncate(turns[lastUserIndex].text, LATEST_USER_CHAR_LIMIT)}`,
          latestReply
            ? `Assistant:\n${truncate(latestReply.text, LATEST_REPLY_CHAR_LIMIT)}`
            : 'No reply was recorded for this message; the turn may have been interrupted.',
        ].join('\n\n')
      : null;

  // The latest exchange is reserved first; everything older shares what is
  // left, so a long history can never push the current state out of the brief.
  let budget = BRIEF_MAX_CHARS - (latest ? latest.length + SECTION_GAP.length : 0);
  const head = truncate(sections.join(SECTION_GAP), budget);
  budget -= head.length;
  const parts = [head];

  if (!input.referenceSessionId) {
    // No reader: inline the turns before the latest exchange, newest first
    // until the budget runs out, so the target still sees how the work got here.
    const earlier: string[] = [];
    let remaining = budget - SECTION_GAP.length - EARLIER_HEADING_RESERVE;
    for (const turn of turns.slice(0, Math.max(0, lastUserIndex)).slice(-INLINE_TURN_COUNT).reverse()) {
      const entry = `${turn.role}:\n${truncate(turn.text, INLINE_TURN_CHAR_LIMIT)}`;
      if (entry.length + SECTION_GAP.length > remaining) break;
      earlier.unshift(entry);
      remaining -= entry.length + SECTION_GAP.length;
    }
    if (earlier.length > 0) {
      parts.push(`## Earlier turns (most recent ${earlier.length})\n${earlier.join(SECTION_GAP)}`);
    }
  }

  if (latest) parts.push(latest);
  return parts.join(SECTION_GAP);
}

/** Live workspace state at the first prompt; git details are best effort. */
export async function readHandoffWorkspace(cwd: string | null | undefined): Promise<HandoffWorkspace | null> {
  if (!cwd) return null;
  try {
    const [branch, status] = await Promise.all([getCurrentBranch(cwd), getShortStatus(cwd)]);
    return { cwd, branch, status };
  } catch {
    return { cwd, branch: null, status: null };
  }
}

function formatWorkspace(workspace: HandoffWorkspace | null | undefined): string | null {
  if (!workspace) return null;
  const lines = ['## Workspace', `Working directory: ${workspace.cwd}`];
  if (workspace.branch) lines.push(`Branch: ${workspace.branch}`);
  if (workspace.status) {
    lines.push(
      workspace.status.length === 0
        ? 'Uncommitted changes: none'
        : `Uncommitted changes (git status --short):\n${formatList(workspace.status, (line) => line)}`
    );
  }
  return lines.join('\n');
}

function extractLatestTodos(history: StreamMessage[]): Array<{ content: string; status: string }> {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message.type !== 'assistant' || !Array.isArray(message.message?.content)) continue;
    for (let blockIndex = message.message.content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = message.message.content[blockIndex] as { type?: string; name?: string; input?: { todos?: unknown } };
      if (block.type !== 'tool_use' || block.name !== 'TodoWrite' || !Array.isArray(block.input?.todos)) continue;
      return block.input.todos.flatMap((todo) => {
        const item = todo as { content?: unknown; status?: unknown };
        const content = typeof item.content === 'string' ? item.content.trim() : '';
        const status = typeof item.status === 'string' ? item.status : 'pending';
        return content ? [{ content, status }] : [];
      });
    }
  }
  return [];
}

function displayPath(filePath: string, cwd: string | undefined): string {
  if (!cwd || !path.isAbsolute(filePath)) return filePath;
  const relative = path.relative(cwd, filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : filePath;
}

function formatList<T>(items: T[], format: (item: T) => string): string {
  const shown = items.slice(0, LIST_ITEM_LIMIT).map(format);
  if (items.length > LIST_ITEM_LIMIT) shown.push(`… and ${items.length - LIST_ITEM_LIMIT} more`);
  return shown.join('\n');
}

function truncate(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
}

function findLast<T>(items: T[], predicate: (item: T) => boolean): T | undefined {
  const index = findLastIndex(items, predicate);
  return index >= 0 ? items[index] : undefined;
}

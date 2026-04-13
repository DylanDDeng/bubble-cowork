import type {
  AskUserQuestionInput,
  ContentBlock,
  PermissionRequestPayload,
  StreamMessage,
  ToolStatus,
  TurnPhase,
} from '../types';
import { getMessageContentBlocks } from './message-content';
import { getToolSummary, safeJsonStringify } from './tool-summary';
import { extractLatestTodoProgress } from './todo-progress';

export type ToolUseBlock = ContentBlock & { type: 'tool_use' };
export type ToolResultBlock = ContentBlock & { type: 'tool_result' };

export type WorkstreamEntry =
  | {
      id: string;
      type: 'thinking';
      summary: string;
      detail?: string;
      state?: 'active' | 'completed';
    }
  | {
      id: string;
      type: 'note';
      summary: string;
      detail?: string;
    }
  | {
      id: string;
      type: 'tool' | 'task' | 'memory';
      toolName: string;
      summary: string;
      detail?: string;
      status: ToolStatus;
      block: ToolUseBlock;
      result?: ToolResultBlock;
    }
  | {
      id: string;
      type: 'approval';
      summary: string;
      detail?: string;
      state: 'waiting' | 'approved' | 'denied';
    }
  | {
      id: string;
      type: 'error';
      summary: string;
      detail?: string;
    };

export type WorkstreamState = 'running' | 'completed' | 'waiting' | 'error';

export interface WorkstreamModel {
  state: WorkstreamState;
  title: string;
  summary: string;
  entries: WorkstreamEntry[];
  previewEntries: WorkstreamEntry[];
  toolCount: number;
  noteCount: number;
  hiddenEntryCount: number;
  todoProgress: ReturnType<typeof extractLatestTodoProgress> | null;
}

type TraceEntry =
  | { type: 'thinking'; id: string; content: string }
  | { type: 'note'; id: string; content: string }
  | { type: 'tool'; id: string; block: ToolUseBlock };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function truncateSummary(content: string, maxChars = 140): string {
  const trimmed = content.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxChars).trimEnd()}...`;
}

function isAskUserQuestionInput(input: unknown): input is AskUserQuestionInput {
  return (
    typeof input === 'object' &&
    input !== null &&
    'questions' in input &&
    Array.isArray((input as { questions?: unknown }).questions)
  );
}

function isMemoryTool(toolName: string): boolean {
  return (
    toolName === 'remember_search' ||
    toolName === 'remember_get' ||
    toolName === 'remember_write' ||
    toolName === 'remember_recent' ||
    toolName.startsWith('aegis_memory_') ||
    toolName.endsWith('__remember_search') ||
    toolName.endsWith('__remember_get') ||
    toolName.endsWith('__remember_write') ||
    toolName.endsWith('__remember_recent')
  );
}

function getApprovalStateFromRequest(
  request: PermissionRequestPayload
): Extract<WorkstreamEntry, { type: 'approval' }> {
  if (isAskUserQuestionInput(request.input)) {
    const firstQuestion = request.input.questions[0];
    const summary =
      (firstQuestion?.header?.trim() || firstQuestion?.question?.trim() || request.toolName).trim();
    const detail = firstQuestion?.question?.trim() || undefined;
    return {
      id: `approval-${request.toolUseId}`,
      type: 'approval',
      summary,
      detail,
      state: 'waiting',
    };
  }

  if (isRecord(request.input) && request.input.kind === 'external-file-access') {
    return {
      id: `approval-${request.toolUseId}`,
      type: 'approval',
      summary: getString(request.input.question) || 'Waiting for permission',
      detail: getString(request.input.filePath) || undefined,
      state: 'waiting',
    };
  }

  return {
    id: `approval-${request.toolUseId}`,
    type: 'approval',
    summary: 'Waiting for approval',
    detail: request.toolName,
    state: 'waiting',
  };
}

export function extractToolBlocks(
  messages: (StreamMessage & { type: 'assistant' })[]
): ToolUseBlock[] {
  const blocks: ToolUseBlock[] = [];
  for (const msg of messages) {
    for (const block of getMessageContentBlocks(msg)) {
      if (block.type === 'tool_use') {
        blocks.push(block as ToolUseBlock);
      }
    }
  }
  return blocks;
}

export function extractTraceEntries(
  messages: (StreamMessage & { type: 'assistant' })[]
): TraceEntry[] {
  const entries: TraceEntry[] = [];

  for (const msg of messages) {
    for (const block of getMessageContentBlocks(msg)) {
      if (block.type === 'thinking' && block.thinking?.trim()) {
        entries.push({
          type: 'thinking',
          id: `thinking-${entries.length}`,
          content: block.thinking.trim(),
        });
      } else if (block.type === 'text' && block.text?.trim()) {
        entries.push({
          type: 'note',
          id: `note-${entries.length}`,
          content: block.text.trim(),
        });
      } else if (block.type === 'tool_use') {
        entries.push({
          type: 'tool',
          id: block.id,
          block: block as ToolUseBlock,
        });
      }
    }
  }

  return entries;
}

function createEntryFromTrace(
  entry: TraceEntry,
  toolStatusMap: Map<string, ToolStatus>,
  toolResultsMap: Map<string, ToolResultBlock>
): WorkstreamEntry | null {
  if (entry.type === 'thinking') {
    return {
      id: entry.id,
      type: 'thinking',
      summary: truncateSummary(entry.content, 120),
      detail: entry.content,
      state: 'completed',
    };
  }

  if (entry.type === 'note') {
    return {
      id: entry.id,
      type: 'note',
      summary: truncateSummary(entry.content, 140),
      detail: entry.content,
    };
  }

  const block = entry.block;
  const status = toolStatusMap.get(block.id) || 'pending';
  const result = toolResultsMap.get(block.id);
  const summary = getToolSummary(block.name, block.input) || block.name;
  const detail = result?.is_error
    ? typeof result.content === 'string'
      ? result.content
      : safeJsonStringify(result.content)
    : undefined;

  if (block.name === 'AskUserQuestion') {
    return {
      id: block.id,
      type: 'approval',
      summary,
      detail,
      state: status === 'error' ? 'denied' : status === 'success' ? 'approved' : 'waiting',
    };
  }

  if (block.name === 'Task') {
    return {
      id: block.id,
      type: 'task',
      toolName: block.name,
      summary,
      detail,
      status,
      block,
      result,
    };
  }

  if (isMemoryTool(block.name)) {
    return {
      id: block.id,
      type: 'memory',
      toolName: block.name,
      summary,
      detail,
      status,
      block,
      result,
    };
  }

  return {
    id: block.id,
    type: 'tool',
    toolName: block.name,
    summary,
    detail,
    status,
    block,
    result,
  };
}

function deriveWorkstreamState(
  entries: WorkstreamEntry[],
  isSessionRunning: boolean
): WorkstreamState {
  if (entries.some((entry) => entry.type === 'approval' && entry.state === 'waiting')) {
    return 'waiting';
  }

  if (
    entries.some(
      (entry) =>
        entry.type === 'error' ||
        ((entry.type === 'tool' || entry.type === 'task' || entry.type === 'memory') &&
          entry.status === 'error')
    )
  ) {
    return 'error';
  }

  if (isSessionRunning || entries.some((entry) => 'status' in entry && entry.status === 'pending')) {
    return 'running';
  }

  return 'completed';
}

function buildWorkstreamTitle(state: WorkstreamState): string {
  switch (state) {
    case 'waiting':
      return 'Waiting for input';
    case 'error':
      return 'Needs attention';
    case 'running':
      return 'Working';
    case 'completed':
    default:
      return 'Completed';
  }
}

function buildWorkstreamSummary(entries: WorkstreamEntry[], state: WorkstreamState): string {
  const waitingEntry = entries.find((entry) => entry.type === 'approval' && entry.state === 'waiting');
  if (waitingEntry) {
    return waitingEntry.summary;
  }

  const erroredEntry = entries.find(
    (entry) =>
      entry.type === 'error' ||
      ((entry.type === 'tool' || entry.type === 'task' || entry.type === 'memory') && entry.status === 'error')
  );
  if (erroredEntry) {
    return erroredEntry.summary;
  }

  const latestTask = [...entries].reverse().find((entry) => entry.type === 'task');
  if (latestTask) {
    return latestTask.summary;
  }

  const latestTool = [...entries].reverse().find(
    (entry) => entry.type === 'tool' || entry.type === 'memory'
  );
  if (latestTool) {
    return latestTool.summary;
  }

  const latestThinking = [...entries].reverse().find((entry) => entry.type === 'thinking');
  if (latestThinking) {
    return latestThinking.summary;
  }

  if (state === 'running') {
    return 'Preparing response';
  }

  return 'No work details yet';
}

function buildPreviewEntries(entries: WorkstreamEntry[]): WorkstreamEntry[] {
  if (entries.length <= 3) {
    return entries;
  }

  const prioritizedIds: string[] = [];
  const lastApproval = [...entries].reverse().find((entry) => entry.type === 'approval');
  const lastError = [...entries].reverse().find(
    (entry) =>
      entry.type === 'error' ||
      ((entry.type === 'tool' || entry.type === 'task' || entry.type === 'memory') &&
        entry.status === 'error')
  );

  if (lastApproval) prioritizedIds.push(lastApproval.id);
  if (lastError && !prioritizedIds.includes(lastError.id)) prioritizedIds.push(lastError.id);

  const tailEntries = entries.slice(-3);
  for (const entry of tailEntries) {
    if (!prioritizedIds.includes(entry.id)) {
      prioritizedIds.push(entry.id);
    }
  }

  const prioritized = entries.filter((entry) => prioritizedIds.includes(entry.id));
  return prioritized.slice(-3);
}

export function createBatchWorkstreamModel(params: {
  messages: (StreamMessage & { type: 'assistant' })[];
  toolStatusMap: Map<string, ToolStatus>;
  toolResultsMap: Map<string, ToolResultBlock>;
  isSessionRunning: boolean;
}): WorkstreamModel {
  const allBlocks = extractToolBlocks(params.messages);
  const traceEntries = extractTraceEntries(params.messages);
  const entries = traceEntries
    .filter((entry) => !(entry.type === 'tool' && entry.block.name === 'TodoWrite'))
    .map((entry) => createEntryFromTrace(entry, params.toolStatusMap, params.toolResultsMap))
    .filter((entry): entry is WorkstreamEntry => Boolean(entry));

  const state = deriveWorkstreamState(entries, params.isSessionRunning);
  const previewEntries = buildPreviewEntries(entries);
  const toolCount = entries.filter(
    (entry) => entry.type === 'tool' || entry.type === 'task' || entry.type === 'memory'
  ).length;
  const noteCount = entries.filter(
    (entry) => entry.type === 'note' || entry.type === 'thinking'
  ).length;

  return {
    state,
    title: buildWorkstreamTitle(state),
    summary: buildWorkstreamSummary(entries, state),
    entries,
    previewEntries,
    toolCount,
    noteCount,
    hiddenEntryCount: Math.max(entries.length - previewEntries.length, 0),
    todoProgress: extractLatestTodoProgress(allBlocks),
  };
}

export function createStreamingWorkstreamModel(params: {
  partialThinking: string;
  phase: TurnPhase;
  permissionRequests?: PermissionRequestPayload[];
}): WorkstreamModel | null {
  const permissionEntries = (params.permissionRequests || []).map(getApprovalStateFromRequest);
  const thinkingEntry =
    params.partialThinking.trim().length > 0
      ? ({
          id: 'streaming-thinking',
          type: 'thinking',
          summary: truncateSummary(params.partialThinking, 120),
          detail: params.partialThinking,
          state: 'active',
        } satisfies WorkstreamEntry)
      : null;

  const entries = [...permissionEntries, ...(thinkingEntry ? [thinkingEntry] : [])];

  if (entries.length === 0 && params.phase === 'complete') {
    return null;
  }

  const state =
    permissionEntries.length > 0
      ? 'waiting'
      : params.phase === 'complete'
        ? 'completed'
        : 'running';
  const summary =
    permissionEntries[0]?.summary ||
    (thinkingEntry ? thinkingEntry.summary : params.phase === 'awaiting' ? 'Waiting for the next step' : 'Preparing response');

  const previewEntries = buildPreviewEntries(entries);

  return {
    state,
    title: buildWorkstreamTitle(state),
    summary,
    entries,
    previewEntries,
    toolCount: 0,
    noteCount: entries.length,
    hiddenEntryCount: Math.max(entries.length - previewEntries.length, 0),
    todoProgress: null,
  };
}

export function parseToolResultPayload(result: ToolResultBlock | undefined): Record<string, unknown> | null {
  if (!result || typeof result.content !== 'string') {
    return null;
  }

  try {
    const parsed = JSON.parse(result.content) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function getToolResultDiffContent(result: ToolResultBlock | undefined): string | null {
  const payload = parseToolResultPayload(result);
  const metadata = isRecord(payload?.metadata) ? payload.metadata : null;
  return getString(metadata?.diff);
}

export function getToolInputFilePath(input: Record<string, unknown>): string | null {
  return getString(input.file_path) || getString(input.path) || getString(input.filePath) || getString(input.filename);
}

export function getToolInputContent(input: Record<string, unknown>): string | null {
  return getString(input.content) || getString(input.text) || getString(input.data) || getString(input.file_content);
}

export function getToolInputOldText(input: Record<string, unknown>): string | null {
  return (
    getString(input.old_string) ||
    getString(input.oldText) ||
    getString(input.old_text) ||
    getString(input.search) ||
    getString(input.before) ||
    getString(input.original)
  );
}

export function getToolInputNewText(input: Record<string, unknown>): string | null {
  return (
    getString(input.new_string) ||
    getString(input.newText) ||
    getString(input.new_text) ||
    getString(input.replace) ||
    getString(input.replacement) ||
    getString(input.after) ||
    getString(input.updated)
  );
}

export { safeJsonStringify };

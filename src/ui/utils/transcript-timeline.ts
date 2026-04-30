import type { ContentBlock, StreamMessage } from '../types';
import {
  getMessageContentBlocks,
  isAnyToolResultBlockType,
  normalizeToolUseBlock,
} from './message-content';

type AssistantMessage = StreamMessage & { type: 'assistant' };
const UNATTRIBUTED_ASSISTANT_RUN_KEY = 'assistant:unattributed';

export type AssistantTimelinePresentation = 'answer' | 'progress';

export interface TimelineWorkGroup {
  id: string;
  messages: AssistantMessage[];
  originalIndices: number[];
}

export type TranscriptTimelineItem =
  | {
      type: 'message';
      message: StreamMessage;
      originalIndex: number;
      assistantPresentation?: AssistantTimelinePresentation;
      inlineWorkGroup?: TimelineWorkGroup;
    }
  | {
      type: 'work';
      group: TimelineWorkGroup;
      active: boolean;
      defaultExpanded: boolean;
      disclosureResetKey: string;
    };

function isToolResultOnlyMessage(message: StreamMessage): boolean {
  if (message.type !== 'user') return false;
  const blocks = getMessageContentBlocks(message);
  return blocks.length > 0 && blocks.every((block) => isAnyToolResultBlockType(block.type));
}

function isTraceBlock(block: ContentBlock): boolean {
  return block.type === 'thinking' || Boolean(normalizeToolUseBlock(block));
}

function isTextBlock(block: ContentBlock): block is ContentBlock & { type: 'text' } {
  return block.type === 'text' && Boolean(block.text?.trim());
}

function cloneAssistantMessageWithContent(
  message: AssistantMessage,
  content: ContentBlock[]
): AssistantMessage {
  return {
    ...message,
    message: {
      ...message.message,
      content,
    },
  };
}

function createWorkGroup(
  messages: AssistantMessage[],
  originalIndices: number[]
): TimelineWorkGroup {
  const firstMessage = messages[0];
  const firstIndex = originalIndices[0] ?? 0;
  const firstUuid =
    typeof firstMessage?.uuid === 'string' && firstMessage.uuid.length > 0
      ? firstMessage.uuid
      : 'work';

  return {
    id: `work:${firstIndex}:${firstUuid}`,
    messages,
    originalIndices,
  };
}

function getAssistantRunBoundaryKey(message: AssistantMessage): string {
  const agentRunId = typeof message.agentRunId === 'string' ? message.agentRunId.trim() : '';
  if (agentRunId) {
    return `run:${agentRunId}`;
  }

  const agentId = typeof message.agentId === 'string' ? message.agentId.trim() : '';
  if (agentId) {
    return `agent:${agentId}`;
  }

  return UNATTRIBUTED_ASSISTANT_RUN_KEY;
}

function getWorkGroupRunBoundaryKey(group: TimelineWorkGroup): string | null {
  const keys = new Set(group.messages.map(getAssistantRunBoundaryKey));
  if (keys.size !== 1) {
    return null;
  }
  return keys.values().next().value || null;
}

function getTimelineItemRunBoundaryKey(item: TranscriptTimelineItem): string | undefined {
  if (item.type === 'work') {
    return getWorkGroupRunBoundaryKey(item.group) || 'assistant:mixed';
  }

  if (item.type === 'message' && item.message.type === 'assistant') {
    return getAssistantRunBoundaryKey(item.message);
  }

  return undefined;
}

function attachWorkToPreviousAssistant(
  items: TranscriptTimelineItem[],
  group: TimelineWorkGroup
): boolean {
  const previous = items[items.length - 1];
  if (!previous || previous.type !== 'message' || previous.message.type !== 'assistant') {
    return false;
  }
  if (getAssistantRunBoundaryKey(previous.message) !== getWorkGroupRunBoundaryKey(group)) {
    return false;
  }

  previous.inlineWorkGroup = previous.inlineWorkGroup
    ? {
        id: previous.inlineWorkGroup.id,
        messages: [...previous.inlineWorkGroup.messages, ...group.messages],
        originalIndices: [...previous.inlineWorkGroup.originalIndices, ...group.originalIndices],
      }
    : group;
  return true;
}

function markAssistantMessagePresentation(items: TranscriptTimelineItem[]): void {
  let currentTurnAssistantItems: Array<
    Extract<TranscriptTimelineItem, { type: 'message' }> & { message: AssistantMessage }
  > = [];

  const flushTurn = () => {
    if (currentTurnAssistantItems.length === 0) {
      return;
    }

    currentTurnAssistantItems.forEach((item, index) => {
      item.assistantPresentation =
        index === currentTurnAssistantItems.length - 1 ? 'answer' : 'progress';
    });
    currentTurnAssistantItems = [];
  };
  let currentRunBoundaryKey: string | null = null;

  for (const item of items) {
    if (item.type !== 'message') {
      continue;
    }

    if (item.message.type === 'user_prompt') {
      flushTurn();
      currentRunBoundaryKey = null;
      continue;
    }

    if (item.message.type === 'assistant') {
      const nextRunBoundaryKey = getAssistantRunBoundaryKey(item.message);
      if (currentTurnAssistantItems.length > 0 && currentRunBoundaryKey !== nextRunBoundaryKey) {
        flushTurn();
      }
      if (currentTurnAssistantItems.length === 0) {
        currentRunBoundaryKey = nextRunBoundaryKey;
      }
      currentTurnAssistantItems.push(
        item as Extract<TranscriptTimelineItem, { type: 'message' }> & {
          message: AssistantMessage;
        }
      );
    }
  }

  flushTurn();
}

function isActiveWorkGroup(
  group: TimelineWorkGroup,
  options: { activeTurnStartIndex?: number; sessionRunning?: boolean }
): boolean {
  return (
    options.sessionRunning === true &&
    typeof options.activeTurnStartIndex === 'number' &&
    group.originalIndices.some((index) => index > options.activeTurnStartIndex!)
  );
}

function combineWorkGroups(groups: TimelineWorkGroup[]): TimelineWorkGroup | null {
  const messages = groups.flatMap((group) => group.messages);
  const originalIndices = groups.flatMap((group) => group.originalIndices);
  if (messages.length === 0) {
    return null;
  }
  return createWorkGroup(messages, originalIndices);
}

function collapseTurnWorkBeforeAnswer(
  turnItems: TranscriptTimelineItem[],
  options: { activeTurnStartIndex?: number; sessionRunning?: boolean }
): TranscriptTimelineItem[] {
  const answerSourceIndex = (() => {
    for (let index = turnItems.length - 1; index >= 0; index -= 1) {
      const item = turnItems[index];
      if (item?.type === 'message' && item.message.type === 'assistant') {
        return index;
      }
    }
    return -1;
  })();
  const answerItem =
    answerSourceIndex >= 0 && turnItems[answerSourceIndex]?.type === 'message'
      ? (turnItems[answerSourceIndex] as Extract<TranscriptTimelineItem, { type: 'message' }>)
      : null;
  const answerHasTrailingWork =
    answerItem?.inlineWorkGroup?.originalIndices.some((index) => index > answerItem.originalIndex) ?? false;
  const hasTerminalAnswer =
    answerSourceIndex >= 0 && (options.sessionRunning !== true || !answerHasTrailingWork);

  const workGroups: TimelineWorkGroup[] = [];
  const visibleItems: TranscriptTimelineItem[] = [];
  let answerVisibleIndex = -1;

  for (let index = 0; index < turnItems.length; index += 1) {
    const item = turnItems[index];

    if (item.type === 'work') {
      workGroups.push(item.group);
      continue;
    }

    if (item.type !== 'message') {
      visibleItems.push(item);
      continue;
    }

    if (item.message.type === 'assistant' && index !== answerSourceIndex) {
      if (item.inlineWorkGroup) {
        workGroups.push(item.inlineWorkGroup);
      }
      workGroups.push(createWorkGroup([item.message], [item.originalIndex]));
      continue;
    }

    if (item.inlineWorkGroup) {
      workGroups.push(item.inlineWorkGroup);
    }

    const visibleItem: TranscriptTimelineItem = {
      ...item,
      inlineWorkGroup: undefined,
    };
    visibleItems.push(visibleItem);

    if (index === answerSourceIndex) {
      answerVisibleIndex = visibleItems.length - 1;
    }
  }

  const combinedWorkGroup = combineWorkGroups(workGroups);
  if (!combinedWorkGroup) {
    return visibleItems;
  }

  const workItem: TranscriptTimelineItem = {
    type: 'work',
    group: combinedWorkGroup,
    active: isActiveWorkGroup(combinedWorkGroup, options) && !hasTerminalAnswer,
    defaultExpanded: isActiveWorkGroup(combinedWorkGroup, options) && !hasTerminalAnswer,
    disclosureResetKey: [
      combinedWorkGroup.id,
      hasTerminalAnswer ? 'answered' : 'working',
      combinedWorkGroup.messages.length,
      combinedWorkGroup.originalIndices.join(','),
    ].join(':'),
  };

  if (answerVisibleIndex >= 0) {
    visibleItems.splice(answerVisibleIndex, 0, workItem);
  } else {
    visibleItems.push(workItem);
  }

  return visibleItems;
}

function collapseWorkBeforeTerminalAnswers(
  items: TranscriptTimelineItem[],
  options: { activeTurnStartIndex?: number; sessionRunning?: boolean }
): TranscriptTimelineItem[] {
  const result: TranscriptTimelineItem[] = [];
  let currentTurnItems: TranscriptTimelineItem[] = [];

  const flushTurn = () => {
    if (currentTurnItems.length === 0) {
      return;
    }
    result.push(...collapseTurnWorkBeforeAnswer(currentTurnItems, options));
    currentTurnItems = [];
  };

  let currentRunBoundaryKey: string | null = null;
  let hasAssistantRunBoundary = false;

  for (const item of items) {
    if (item.type === 'message' && item.message.type === 'user_prompt') {
      flushTurn();
      currentRunBoundaryKey = null;
      hasAssistantRunBoundary = false;
      result.push(item);
      continue;
    }

    const itemRunBoundaryKey = getTimelineItemRunBoundaryKey(item);
    if (itemRunBoundaryKey !== undefined) {
      if (hasAssistantRunBoundary && currentRunBoundaryKey !== itemRunBoundaryKey) {
        flushTurn();
        currentRunBoundaryKey = null;
        hasAssistantRunBoundary = false;
      }
      if (!hasAssistantRunBoundary) {
        currentRunBoundaryKey = itemRunBoundaryKey;
        hasAssistantRunBoundary = true;
      }
    }

    currentTurnItems.push(item);
  }

  flushTurn();
  return result;
}

export function deriveTranscriptTimelineItems(
  messages: StreamMessage[],
  options: { activeTurnStartIndex?: number; sessionRunning?: boolean } = {}
): TranscriptTimelineItem[] {
  const items: TranscriptTimelineItem[] = [];
  let pendingWorkMessages: AssistantMessage[] = [];
  let pendingWorkOriginalIndices: number[] = [];

  const flushPendingWork = (attachToPreviousAssistant = true) => {
    if (pendingWorkMessages.length === 0) return;
    const group = createWorkGroup(pendingWorkMessages, pendingWorkOriginalIndices);
    if (!attachToPreviousAssistant || !attachWorkToPreviousAssistant(items, group)) {
      const active = isActiveWorkGroup(group, options);
      items.push({
        type: 'work',
        group,
        active,
        defaultExpanded: active,
        disclosureResetKey: [
          group.id,
          active ? 'working' : 'answered',
          group.messages.length,
          group.originalIndices.join(','),
        ].join(':'),
      });
    }
    pendingWorkMessages = [];
    pendingWorkOriginalIndices = [];
  };

  const queueWork = (message: AssistantMessage, originalIndex: number, blocks: ContentBlock[]) => {
    if (blocks.length === 0) return;
    pendingWorkMessages.push(cloneAssistantMessageWithContent(message, blocks));
    pendingWorkOriginalIndices.push(originalIndex);
  };

  const pushMessage = (message: StreamMessage, originalIndex: number) => {
    const item: TranscriptTimelineItem = { type: 'message', message, originalIndex };
    if (message.type === 'assistant' && pendingWorkMessages.length > 0) {
      const group = createWorkGroup(pendingWorkMessages, pendingWorkOriginalIndices);
      if (getAssistantRunBoundaryKey(message) === getWorkGroupRunBoundaryKey(group)) {
        item.inlineWorkGroup = group;
        pendingWorkMessages = [];
        pendingWorkOriginalIndices = [];
      } else {
        flushPendingWork();
      }
    } else {
      flushPendingWork();
    }
    items.push(item);
  };

  for (let originalIndex = 0; originalIndex < messages.length; originalIndex += 1) {
    const message = messages[originalIndex];

    if (message.type === 'stream_event' || isToolResultOnlyMessage(message)) {
      continue;
    }

    if (message.type === 'user_prompt') {
      flushPendingWork();
      items.push({ type: 'message', message, originalIndex });
      continue;
    }

    if (message.type !== 'assistant') {
      pushMessage(message, originalIndex);
      continue;
    }

    const blocks = getMessageContentBlocks(message);
    let traceBuffer: ContentBlock[] = [];
    let textBuffer: ContentBlock[] = [];

    const flushTraceBuffer = () => {
      if (traceBuffer.length === 0) return;
      queueWork(message, originalIndex, traceBuffer);
      traceBuffer = [];
    };

    const flushTextBuffer = () => {
      if (textBuffer.length === 0) return;
      pushMessage(cloneAssistantMessageWithContent(message, textBuffer), originalIndex);
      textBuffer = [];
    };

    for (const block of blocks) {
      if (isTraceBlock(block)) {
        flushTextBuffer();
        traceBuffer.push(block);
        continue;
      }

      if (isTextBlock(block)) {
        flushTraceBuffer();
        textBuffer.push(block);
      }
    }

    flushTraceBuffer();
    flushTextBuffer();
  }

  flushPendingWork();
  markAssistantMessagePresentation(items);
  return collapseWorkBeforeTerminalAnswers(items, options);
}

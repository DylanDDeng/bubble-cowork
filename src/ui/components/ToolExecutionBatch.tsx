import { useMemo } from 'react';
import type { ContentBlock, ToolStatus, StreamMessage } from '../types';
import { AssistantWorkstream } from './AssistantWorkstream';
import { createBatchWorkstreamModel, type ToolResultBlock } from '../utils/workstream';
import { TodoProgressCard } from './TodoProgressCard';

type AssistantMessage = StreamMessage & { type: 'assistant' };

interface ToolExecutionBatchProps {
  messages: AssistantMessage[];
  toolStatusMap: Map<string, ToolStatus>;
  toolResultsMap: Map<string, ToolResultBlock>;
  isSessionRunning: boolean;
}

export function ToolExecutionBatch({
  messages,
  toolStatusMap,
  toolResultsMap,
  isSessionRunning,
}: ToolExecutionBatchProps) {
  const model = useMemo(
    () =>
      createBatchWorkstreamModel({
        messages,
        toolStatusMap,
        toolResultsMap,
        isSessionRunning,
      }),
    [messages, toolResultsMap, toolStatusMap, isSessionRunning]
  );

  if (model.entries.length === 0 && model.todoProgress) {
    return <TodoProgressCard state={model.todoProgress} className="my-2" />;
  }

  if (model.entries.length === 0) {
    return null;
  }

  return <AssistantWorkstream model={model} />;
}

export type ToolUseBlock = ContentBlock & { type: 'tool_use' };

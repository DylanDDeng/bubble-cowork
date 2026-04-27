import { useMemo } from 'react';
import type { ContentBlock, ToolStatus, StreamMessage } from '../types';
import { AssistantWorkstream, ResponseDivider, WorkingFooter } from './AssistantWorkstream';
import { createBatchWorkstreamModel, type ToolResultBlock } from '../utils/workstream';
import { TodoProgressCard } from './TodoProgressCard';

type AssistantMessage = StreamMessage & { type: 'assistant' };

interface ToolExecutionBatchProps {
  messages: AssistantMessage[];
  toolStatusMap: Map<string, ToolStatus>;
  toolResultsMap: Map<string, ToolResultBlock>;
  isSessionRunning: boolean;
  /** When true, render a "Response · Worked for Xs" divider after the trace.
   * ChatPane sets this when the next aggregated item is a standalone assistant
   * text message. Codex can start that final text before its session status has
   * flipped to completed, so this is intentionally independent of running state. */
  showResponseDivider?: boolean;
  /** True only for the LAST tool_batch in the aggregated transcript. Without
   * this gate, every historical batch would also report `state==='running'`
   * while the session is mid-turn (because deriveWorkstreamState OR's in
   * isSessionRunning) and each would mount its own setInterval-backed
   * WorkingFooter — N historical batches × 1s ticks = main-thread freeze. */
  isLastBatch?: boolean;
}

export function ToolExecutionBatch({
  messages,
  toolStatusMap,
  toolResultsMap,
  isSessionRunning,
  showResponseDivider = false,
  isLastBatch = false,
}: ToolExecutionBatchProps) {
  const batchIsRunning = isSessionRunning && isLastBatch;
  const model = useMemo(
    () =>
      createBatchWorkstreamModel({
        messages,
        toolStatusMap,
        toolResultsMap,
        isSessionRunning: batchIsRunning,
      }),
    [messages, toolResultsMap, toolStatusMap, batchIsRunning]
  );

  if (model.entries.length === 0 && model.todoProgress) {
    return <TodoProgressCard state={model.todoProgress} className="my-2" />;
  }

  if (model.entries.length === 0) {
    return null;
  }

  const showDivider = showResponseDivider;
  const showWorking = batchIsRunning && !showDivider;
  const dividerDurationMs =
    showDivider ? model.durationMs ?? estimateElapsedMs(model.startedAt) : undefined;

  return (
    <>
      <AssistantWorkstream model={model} />
      {showWorking ? <WorkingFooter startedAt={model.startedAt} /> : null}
      {showDivider ? <ResponseDivider durationMs={dividerDurationMs} /> : null}
    </>
  );
}

function estimateElapsedMs(startedAt: number | undefined): number | undefined {
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return undefined;
  return Math.max(0, Date.now() - startedAt);
}

export type ToolUseBlock = ContentBlock & { type: 'tool_use' };

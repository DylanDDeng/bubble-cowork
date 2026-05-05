import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ContentBlock, PermissionRequestPayload, ToolStatus, StreamMessage } from '../types';
import { AssistantWorkstream, WorkingFooter } from './AssistantWorkstream';
import {
  createBatchWorkstreamModel,
  type ToolResultBlock,
  type WorkstreamModel,
} from '../utils/workstream';
import { TodoProgressCard } from './TodoProgressCard';

type AssistantMessage = StreamMessage & { type: 'assistant' };

interface ToolExecutionBatchProps {
  messages: AssistantMessage[];
  toolStatusMap: Map<string, ToolStatus>;
  toolResultsMap: Map<string, ToolResultBlock>;
  isSessionRunning: boolean;
  /** True only for the active work group in the transcript. Without this gate,
   * every historical batch would also report `state==='running'` while the
   * session is mid-turn and each would mount its own setInterval-backed
   * WorkingFooter. */
  isLastBatch?: boolean;
  liveTrace?: {
    partialThinking?: string;
    permissionRequests?: PermissionRequestPayload[];
  };
  expanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  resetKey?: string | number | null;
}

export function ToolExecutionBatch({
  messages,
  toolStatusMap,
  toolResultsMap,
  isSessionRunning,
  isLastBatch = false,
  liveTrace,
  expanded,
  defaultExpanded,
  onExpandedChange,
  resetKey,
}: ToolExecutionBatchProps) {
  const batchIsRunning = isSessionRunning && isLastBatch;
  const model = useMemo(
    () =>
      createBatchWorkstreamModel({
        messages,
        toolStatusMap,
        toolResultsMap,
        isSessionRunning: batchIsRunning,
        liveTrace: batchIsRunning ? liveTrace : undefined,
      }),
    [messages, toolResultsMap, toolStatusMap, batchIsRunning, liveTrace]
  );

  const disclosureResetKey = resetKey ?? messages.map((message) => message.uuid).join(':');
  return (
    <WorkstreamDisclosure
      model={model}
      isRunning={batchIsRunning}
      expanded={expanded}
      defaultExpanded={defaultExpanded}
      onExpandedChange={onExpandedChange}
      resetKey={disclosureResetKey}
    />
  );
}

export function WorkstreamDisclosure({
  model,
  isRunning,
  defaultExpanded = false,
  expanded,
  onExpandedChange,
  resetKey,
}: {
  model: WorkstreamModel;
  isRunning: boolean;
  defaultExpanded?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  resetKey?: string | number | null;
}) {
  const isControlled = typeof expanded === 'boolean';
  const [uncontrolledExpanded, setUncontrolledExpanded] = useState(() => defaultExpanded);
  const previousResetKeyRef = useRef(resetKey);
  const resolvedExpanded = isControlled ? expanded : uncontrolledExpanded;

  useEffect(() => {
    if (isControlled) {
      previousResetKeyRef.current = resetKey;
      return;
    }

    if (previousResetKeyRef.current === resetKey) {
      return;
    }

    previousResetKeyRef.current = resetKey;
    setUncontrolledExpanded(defaultExpanded);
  }, [defaultExpanded, isControlled, resetKey]);

  const setExpanded = (nextExpanded: boolean) => {
    if (isControlled) {
      onExpandedChange?.(nextExpanded);
      return;
    }
    setUncontrolledExpanded(nextExpanded);
  };

  if (model.entries.length === 0 && model.todoProgress) {
    return <TodoProgressCard state={model.todoProgress} className="my-2" />;
  }

  if (model.entries.length === 0) {
    return null;
  }

  const showWorking = resolvedExpanded && isRunning;

  return (
    <>
      <WorkstreamToggle
        expanded={resolvedExpanded}
        model={model}
        isRunning={isRunning}
        onToggle={() => setExpanded(!resolvedExpanded)}
      />
      {resolvedExpanded ? <AssistantWorkstream model={model} /> : null}
      {showWorking ? <WorkingFooter startedAt={model.startedAt} /> : null}
    </>
  );
}

function WorkstreamToggle({
  expanded,
  model,
  isRunning,
  onToggle,
}: {
  expanded: boolean;
  model: WorkstreamModel;
  isRunning: boolean;
  onToggle: () => void;
}) {
  const now = useLiveNow(isRunning);
  const stepCount = model.entries.length;
  const elapsedMs = model.durationMs ?? estimateElapsedMs(model.startedAt, now);
  const elapsedLabel = typeof elapsedMs === 'number' ? formatElapsed(elapsedMs) : null;
  const stateLabel = isRunning ? 'Working' : 'Worked';

  return (
    <button
      type="button"
      onClick={onToggle}
      className="group my-2 flex w-full items-center gap-1.5 py-0.5 text-left text-[12px] leading-5 text-[var(--text-muted)]/60 transition-colors hover:text-[var(--text-secondary)]"
      aria-expanded={expanded}
    >
      <ChevronRight
        className={`h-3 w-3 flex-shrink-0 text-[var(--text-muted)]/45 transition-transform group-hover:text-[var(--text-secondary)]/70 ${
          expanded ? 'rotate-90' : ''
        }`}
      />
      <span>{expanded ? 'Hide work' : 'Show work'}</span>
      <span className="text-[var(--text-muted)]/35">·</span>
      <span>
        {stepCount} step{stepCount === 1 ? '' : 's'}
      </span>
      {elapsedLabel ? (
        <>
          <span className="text-[var(--text-muted)]/35">·</span>
          <span>
            {stateLabel} for {elapsedLabel}
          </span>
        </>
      ) : null}
    </button>
  );
}

function useLiveNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);

  return now;
}

function estimateElapsedMs(startedAt: number | undefined, now = Date.now()): number | undefined {
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return undefined;
  return Math.max(0, now - startedAt);
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

export type ToolUseBlock = ContentBlock & { type: 'tool_use' };

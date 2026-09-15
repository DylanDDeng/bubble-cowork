import { useMemo, useState } from 'react';
import { ChevronRight } from './icons';
import type { ContentBlock, PermissionRequestPayload, ToolStatus, StreamMessage } from '../types';
import { AssistantWorkstream } from './AssistantWorkstream';
import {
  createBatchWorkstreamModel,
  type ToolResultBlock,
  type WorkstreamModel,
} from '../utils/workstream';
import { TodoProgressCard } from './TodoProgressCard';
import { WorkstreamDisclosureState } from './WorkstreamDisclosureState';
import { GeneratedMediaGallery } from './GeneratedMediaGallery';
import { WorkstreamCollapse } from './WorkstreamPrimitives';
import type { GeneratedMediaItem } from '../utils/generated-media';

type AssistantMessage = StreamMessage & { type: 'assistant' };

interface ToolExecutionBatchProps {
  messages: AssistantMessage[];
  toolStatusMap: Map<string, ToolStatus>;
  toolResultsMap: Map<string, ToolResultBlock>;
  isSessionRunning: boolean;
  /** True only for the active work group in the transcript. Without this gate,
   * every historical batch would also report `state==='running'` while the
   * session is mid-turn and show stale activity as running. */
  isLastBatch?: boolean;
  startedAt?: number;
  /** Final duration for a completed turn, resolved by the transcript timeline. */
  durationMs?: number;
  /** Subagent messages keyed by Task tool_use id — nests them under Task rows. */
  subagentMessagesByParent?: Map<string, StreamMessage[]>;
  liveTrace?: {
    partialText?: string;
    partialThinking?: string;
    permissionRequests?: PermissionRequestPayload[];
  };
  /** Streamed stdout/stderr tails keyed by tool_use id (running tools only). */
  toolLiveOutputMap?: Map<string, string>;
  expanded?: boolean;
  defaultExpanded?: boolean;
  canCollapse?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  resetKey?: string | number | null;
  generatedMedia?: GeneratedMediaItem[];
  mediaCwd?: string | null;
}

export function ToolExecutionBatch({
  messages,
  toolStatusMap,
  toolResultsMap,
  isSessionRunning,
  isLastBatch = false,
  startedAt,
  durationMs,
  subagentMessagesByParent,
  liveTrace,
  toolLiveOutputMap,
  expanded,
  defaultExpanded,
  canCollapse,
  onExpandedChange,
  resetKey,
  generatedMedia,
  mediaCwd,
}: ToolExecutionBatchProps) {
  const batchIsRunning = isSessionRunning && isLastBatch;
  const model = useMemo(
    () =>
      createBatchWorkstreamModel({
        messages,
        toolStatusMap,
        toolResultsMap,
        isSessionRunning: batchIsRunning,
        startedAt: batchIsRunning ? startedAt : undefined,
        durationMs,
        subagentMessagesByParent,
        liveTrace: batchIsRunning ? liveTrace : undefined,
        toolLiveOutputMap: batchIsRunning ? toolLiveOutputMap : undefined,
      }),
    [messages, toolResultsMap, toolStatusMap, batchIsRunning, startedAt, durationMs, subagentMessagesByParent, liveTrace, toolLiveOutputMap]
  );

  const disclosureResetKey = resetKey ?? messages[0]?.uuid;
  return (
    <WorkstreamDisclosure
      model={model}
      isRunning={batchIsRunning}
      expanded={expanded}
      defaultExpanded={defaultExpanded}
      allowCollapse={canCollapse}
      onExpandedChange={onExpandedChange}
      resetKey={disclosureResetKey}
      generatedMedia={generatedMedia}
      mediaCwd={mediaCwd}
    />
  );
}

export function WorkstreamDisclosure({
  model,
  isRunning,
  defaultExpanded = false,
  allowCollapse = true,
  expanded,
  onExpandedChange,
  resetKey,
  generatedMedia,
  mediaCwd,
}: {
  model: WorkstreamModel;
  isRunning: boolean;
  defaultExpanded?: boolean;
  allowCollapse?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  resetKey?: string | number | null;
  generatedMedia?: GeneratedMediaItem[];
  mediaCwd?: string | null;
}) {
  const isControlled = typeof expanded === 'boolean';
  // A user choice wins over lifecycle defaults for the lifetime of this turn.
  const [choice, setChoice] = useState<{ key: typeof resetKey; expanded: boolean }>();
  const interrupted = model.entries.some((entry) =>
    (entry.type === 'tool' || entry.type === 'task' || entry.type === 'memory') && entry.status === 'interrupted');
  const canCollapse = allowCollapse && !isRunning && !interrupted;
  const resolvedExpanded = !canCollapse || (isControlled ? expanded
    : choice && choice.key === resetKey ? choice.expanded : defaultExpanded);
  const setExpanded = (nextExpanded: boolean) => {
    if (!isControlled) setChoice({ key: resetKey, expanded: nextExpanded });
    onExpandedChange?.(nextExpanded);
  };

  if (model.entries.length === 0 && model.todoProgress) {
    return <TodoProgressCard state={model.todoProgress} className="my-2" />;
  }

  if (model.entries.length === 0) {
    return null;
  }

  return (
    <WorkstreamDisclosureState key={resetKey}>
      {canCollapse && <WorkstreamToggle
        expanded={resolvedExpanded}
        model={model}
        onToggle={() => setExpanded(!resolvedExpanded)}
      />}
      <WorkstreamCollapse open={resolvedExpanded}>
        <AssistantWorkstream
          model={model}
        />
      </WorkstreamCollapse>
      {generatedMedia?.length ? <GeneratedMediaGallery items={generatedMedia} cwd={mediaCwd ?? null} /> : null}
    </WorkstreamDisclosureState>
  );
}

function WorkstreamToggle({
  expanded,
  model,
  onToggle,
}: {
  expanded: boolean;
  model: WorkstreamModel;
  onToggle: () => void;
}) {
  const duration = model.durationMs;
  const count = model.messageCount ?? model.entries.length;
  const label = typeof duration === 'number' && Number.isFinite(duration)
    ? `Worked for ${formatElapsed(duration)}`
    : `${count} previous message${count === 1 ? '' : 's'}`;

  return (
    <div className="workstream-toggle-row my-2">
      <button type="button" onClick={onToggle}
        className="workstream-text group flex min-w-0 items-center gap-1.5 py-0.5 text-left text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
        aria-expanded={expanded}>
        <span className="min-w-0 truncate">{label}</span>
        <ChevronRight className={`h-3.5 w-3.5 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} />
      </button>
      <div className="mt-1 w-full border-t border-[var(--border)]" data-workstream-divider />
    </div>
  );
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

export type ToolUseBlock = ContentBlock & { type: 'tool_use' };

import { getWorkstreamDeniedActionIds } from '../utils/workstream-stages';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight } from './icons';
import type { ContentBlock, PermissionRequestPayload, ToolStatus, StreamMessage } from '../types';
import { AssistantWorkstream, TurnWorkflowBoards, WorkflowBoardsOutsideProvider } from './AssistantWorkstream';
import {
  createBatchWorkstreamModel,
  type ToolResultBlock,
  type WorkstreamModel,
} from '../utils/workstream';
import { TodoProgressCard } from './TodoProgressCard';
import { WorkstreamDisclosureState, useWorkstreamDisclosure, useWorkstreamWasInspected, useWorkstreamDisclosureActions } from './WorkstreamDisclosureState';
import { GeneratedMediaGallery } from './GeneratedMediaGallery';
import { WorkstreamCollapse, formatWorkstreamElapsed } from './WorkstreamPrimitives';
import type { GeneratedMediaItem } from '../utils/generated-media';

import type { WorkstreamMessage } from '../utils/compaction';

interface ToolExecutionBatchProps {
  messages: WorkstreamMessage[];
  toolStatusMap: Map<string, ToolStatus>;
  toolResultsMap: Map<string, ToolResultBlock>;
  isSessionRunning: boolean;
  /** True only for the active work group in the transcript. Without this gate,
   * every historical batch would also report `state==='running'` while the
   * session is mid-turn and show stale activity as running. */
  isLastBatch?: boolean;
  isStopped?: boolean;
  startedAt?: number;
  /** Final duration for a completed turn, resolved by the transcript timeline. */
  durationMs?: number;
  /** Subagent messages keyed by Task tool_use id — nests them under Task rows. */
  subagentMessagesByParent?: Map<string, StreamMessage[]>;
  liveTrace?: {
    partialText?: string;
    partialThinking?: string;
    retrying?: boolean;
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
  isStopped,
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
      isStopped={isStopped}
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

export function WorkstreamDisclosure(props: WorkstreamDisclosureProps) {
  return <WorkstreamDisclosureState key={props.resetKey} scopeKey={props.resetKey}>
    <WorkstreamDisclosureBody {...props} />
  </WorkstreamDisclosureState>;
}

interface WorkstreamDisclosureProps {
  model: WorkstreamModel;
  isRunning: boolean;
  isStopped?: boolean;
  defaultExpanded?: boolean;
  allowCollapse?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  resetKey?: string | number | null;
  generatedMedia?: GeneratedMediaItem[];
  mediaCwd?: string | null;
}

function WorkstreamDisclosureBody({
  model,
  isRunning,
  isStopped,
  defaultExpanded = false,
  allowCollapse = true,
  expanded,
  onExpandedChange,
  generatedMedia,
  mediaCwd,
}: WorkstreamDisclosureProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const setDetailChoice = useWorkstreamDisclosureActions();
  const [navigation, setNavigation] = useState(0);
  const inspected = useWorkstreamWasInspected();
  const [choice, setChoice] = useWorkstreamDisclosure('turn', defaultExpanded || inspected);
  const interrupted = model.entries.some((entry) =>
    (entry.type === 'tool' || entry.type === 'task' || entry.type === 'memory') && entry.status === 'interrupted');
  const stopped = isStopped ?? (!isRunning && interrupted);
  const compactionOnly = model.entries.length === 1 && model.entries[0].type === 'compaction';
  const canCollapse = allowCollapse && !isRunning && !stopped && !compactionOnly;
  const resolvedExpanded = !canCollapse || (typeof expanded === 'boolean' ? expanded : choice);
  const setExpanded = (nextExpanded: boolean) => {
    setChoice(nextExpanded);
    onExpandedChange?.(nextExpanded);
  };
  const deniedEntries = model.entries.filter(entry => getWorkstreamDeniedActionIds(entry).length > 0);
  const deniedCount = new Set(deniedEntries.flatMap(getWorkstreamDeniedActionIds)).size;
  const revealDenied = () => {
    setExpanded(true);
    const denied = deniedEntries[0];
    if (!denied) return;
    let groupStart = '';
    for (const entry of model.entries) {
      if (entry.type === 'note' || entry.type === 'thinking') groupStart = '';
      else groupStart ||= entry.id;
      if (entry.id === denied.id) break;
    }
    setDetailChoice?.(`group:${groupStart}`, true);
    setDetailChoice?.(`stage:${denied.id}`, true);
    setNavigation(previous => previous + 1);
  };
  useEffect(() => {
    if (!navigation) return;
    let frame = 0;
    let attempts = 0;
    const focusDenied = () => {
      const target = bodyRef.current?.querySelector<HTMLElement>('[data-denied-action]');
      if (target && !target.closest('[inert]') && target.getBoundingClientRect().height > 0) {
        target.scrollIntoView({ block: 'center', behavior: 'instant' });
        target.focus({ preventScroll: true });
        if (document.activeElement === target) return;
      }
      // Nested disclosures may mount on later frames when the renderer is busy.
      if (++attempts < 120) frame = requestAnimationFrame(focusDenied);
    };
    const timer = setTimeout(focusDenied, 320);
    return () => { clearTimeout(timer); cancelAnimationFrame(frame); };
  }, [navigation]);
  const stopSnapshot = useRef<{ startedAt?: number; wasRunning: boolean; durationMs?: number }>({ wasRunning: false });
  if (isRunning) stopSnapshot.current = { startedAt: model.startedAt, wasRunning: true };
  else if (stopSnapshot.current.wasRunning) {
    const startedAt = stopSnapshot.current.startedAt;
    stopSnapshot.current = { wasRunning: false, durationMs: startedAt != null ? Math.max(0, Date.now() - startedAt) : undefined };
  }
  const stoppedDuration = stopSnapshot.current.durationMs ?? model.durationMs;


  if (model.entries.length === 0 && model.todoProgress) {
    return <TodoProgressCard state={model.todoProgress} className="my-2" />;
  }

  if (model.entries.length === 0) {
    return null;
  }

  return (
    <div ref={bodyRef}>
      {canCollapse && <WorkstreamToggle
        expanded={resolvedExpanded}
        model={model}
        onToggle={() => setExpanded(!resolvedExpanded)}
        deniedCount={deniedCount}
        onRevealDenied={revealDenied}
      />}
      {stopped && <div className="workstream-text my-2 text-[var(--text-muted)]" data-workstream-stopped>
        {stoppedDuration != null ? `You stopped after ${formatWorkstreamElapsed(stoppedDuration)}` : 'You stopped'}
        <div className="mt-2 w-full border-t border-[var(--border)]" />
      </div>}
      {/* Live media belongs beside its tool result, before subsequent narration.
          Collapsible traces keep any remaining media outside the hidden body. */}
      <WorkstreamCollapse open={resolvedExpanded}>
        <WorkflowBoardsOutsideProvider value={canCollapse}>
          <AssistantWorkstream
            model={model}
            generatedMedia={canCollapse ? undefined : generatedMedia}
            mediaCwd={mediaCwd}
          />
        </WorkflowBoardsOutsideProvider>
      </WorkstreamCollapse>
      {canCollapse ? <TurnWorkflowBoards entries={model.entries} /> : null}
      {canCollapse && generatedMedia?.length ? <GeneratedMediaGallery items={generatedMedia} cwd={mediaCwd ?? null} /> : null}
    </div>
  );
}

function WorkstreamToggle({
  expanded,
  model,
  onToggle,
  deniedCount,
  onRevealDenied,
}: {
  expanded: boolean;
  model: WorkstreamModel;
  onToggle: () => void;
  deniedCount: number;
  onRevealDenied: () => void;
}) {
  const duration = model.durationMs;
  const count = model.messageCount ?? model.entries.length;
  const label = typeof duration === 'number' && Number.isFinite(duration)
    ? `Worked for ${formatElapsed(duration)}`
    : `${count} previous message${count === 1 ? '' : 's'}`;

  return (
    <div className="workstream-toggle-row my-2">
      <div className="flex items-center gap-2">
      <button type="button" onClick={onToggle}
        className="workstream-text group flex min-w-0 items-center gap-1.5 py-0.5 text-left text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
        aria-expanded={expanded}>
        <span className="min-w-0 truncate">{label}</span>
        <ChevronRight className={`h-3.5 w-3.5 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} />
      </button>
      {deniedCount > 0 && <button type="button" onClick={onRevealDenied} className="workstream-text ml-auto text-[var(--text-muted)] hover:text-[var(--text-primary)]" data-denied-action-count>
        {deniedCount} denied action{deniedCount === 1 ? '' : 's'}
      </button>}
      </div>
      <div className="mt-2 w-full border-t border-[var(--border)]" data-workstream-divider />
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

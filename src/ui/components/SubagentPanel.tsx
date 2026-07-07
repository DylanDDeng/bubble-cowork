import { useMemo } from 'react';
import { useAppStore } from '../store/useAppStore';
import { Loader2, MessageSquare } from './icons';
import type { StreamMessage, ToolStatus } from '../types';
import {
  getMessageContentBlocks,
  normalizeToolUseBlock,
  normalizeToolResultBlock,
} from '../utils/message-content';
import { groupSubagentMessagesByParent } from '../utils/workstream';
import { deriveTranscriptTimelineItems } from '../utils/transcript-timeline';
import { deriveSubagentSummaries, type SubagentSummary } from '../utils/subagent-registry';
import { MessageCard } from './MessageCard';
import { ToolExecutionBatch } from './ToolExecutionBatch';
import { SubagentAvatar } from './SubagentAvatar';

type ToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

/** Live elapsed / final duration, human-friendly. */
function formatDuration(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

type SubagentDisplayState = 'running' | 'done' | 'error' | 'frozen';

function displayState(summary: SubagentSummary, sessionRunning: boolean): SubagentDisplayState {
  if (summary.status === 'success') return 'done';
  if (summary.status === 'error') return 'error';
  if (summary.status === 'interrupted') return 'frozen';
  // pending: live while the session runs; once the turn is over a still-
  // pending subagent has been backgrounded — its trace is frozen (the CLI
  // stops forwarding messages after a Task backgrounds itself).
  return sessionRunning ? 'running' : 'frozen';
}

function StatusDot({ state }: { state: SubagentDisplayState }) {
  const color =
    state === 'running'
      ? 'var(--accent)'
      : state === 'error'
        ? 'var(--danger, #e5484d)'
        : state === 'frozen'
          ? 'var(--text-muted)'
          : 'var(--success, #30a46c)';
  return (
    <span
      className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
      style={{ backgroundColor: color, boxShadow: state === 'running' ? `0 0 0 3px color-mix(in srgb, ${color} 25%, transparent)` : undefined }}
    />
  );
}

/**
 * Read-only detail view for ONE subagent — each subagent gets its own
 * top-level utility tab (`subagent:<id>`), so there is no internal switcher
 * here; the strip tab IS the switcher. No composer — following up goes to the
 * MAIN agent via a visible quote injected into the main composer, because the
 * SDK cannot address a running/finished subagent directly.
 */
export function SubagentPanel({
  collapsed,
  sessionId,
  subagentId,
}: {
  collapsed: boolean;
  sessionId: string | null;
  subagentId: string;
}) {
  const session = useAppStore((s) => (sessionId ? s.sessions[sessionId] ?? null : null));
  const requestChatInjection = useAppStore((s) => s.requestChatInjection);

  const summaries = useMemo(
    () => (session ? deriveSubagentSummaries(session.messages) : []),
    [session?.messages]
  );

  const selected = summaries.find((s) => s.id === subagentId) ?? null;
  const selectedId = selected?.id ?? null;

  const { toolStatusMap, toolResultsMap } = useMemo(() => {
    const statusMap = new Map<string, ToolStatus>();
    const resultsMap = new Map<string, ToolResultBlock>();
    if (!session) return { toolStatusMap: statusMap, toolResultsMap: resultsMap };
    for (const msg of session.messages) {
      if (msg.type !== 'assistant' && msg.type !== 'user') continue;
      for (const block of getMessageContentBlocks(msg)) {
        const use = normalizeToolUseBlock(block);
        if (use) {
          if (!statusMap.has(use.id)) statusMap.set(use.id, 'pending');
          continue;
        }
        const result = normalizeToolResultBlock(block);
        if (result) {
          statusMap.set(result.tool_use_id, result.is_error ? 'error' : 'success');
          resultsMap.set(result.tool_use_id, {
            type: 'tool_result',
            tool_use_id: result.tool_use_id,
            content: result.content,
            is_error: result.is_error,
          });
        }
      }
    }
    return { toolStatusMap: statusMap, toolResultsMap: resultsMap };
  }, [session?.messages]);

  const subagentMessagesByParent = useMemo(
    () => (session ? groupSubagentMessagesByParent(session.messages) : new Map<string, StreamMessage[]>()),
    [session?.messages]
  );

  const sessionRunning = session?.status === 'running';

  const timelineItems = useMemo(() => {
    if (!session || !selectedId) return [];
    return deriveTranscriptTimelineItems(session.messages, {
      subagentScopeId: selectedId,
      sessionRunning,
    });
  }, [session?.messages, selectedId, sessionRunning]);

  if (collapsed) return null;

  const state = selected ? displayState(selected, Boolean(sessionRunning)) : 'done';

  const handleFollowUp = () => {
    if (!selected || !sessionId) return;
    const label = selected.persona.functionalName;
    // A VISIBLE, editable quote in the MAIN composer — not a hidden prefix and
    // not a fake per-subagent input. The user sees exactly what will be sent.
    requestChatInjection({
      sessionId,
      text: `About the "${label}" subagent's work: `,
      mode: 'append',
      source: 'subagent-panel',
    });
  };

  return (
    <div
      className="absolute inset-0 flex min-h-0 flex-col bg-[var(--bg-primary)]"
      data-subagent-panel
    >
      {/* This subagent's transcript — the strip tab is the switcher */}
      {selected ? (
        <>
          <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2 text-xs text-[var(--text-muted)]">
            <div className="flex min-w-0 items-center gap-2">
              <SubagentAvatar id={selected.id} hue={selected.persona.colorHue} size={14} />
              <StatusDot state={state} />
              <span
                className="min-w-0 truncate text-[var(--text-secondary)]"
                title={selected.persona.functionalName}
              >
                {selected.persona.functionalName}
              </span>
              <span className="flex-shrink-0">
                {state === 'running' ? 'Running' : state === 'error' ? 'Failed' : state === 'frozen' ? 'Backgrounded' : 'Done'}
                {typeof selected.durationMs === 'number' ? ` · ${formatDuration(selected.durationMs)}` : ''}
              </span>
            </div>
            <button
              type="button"
              onClick={handleFollowUp}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
              title="Subagents can't be messaged directly — this prefills a quote in the main chat, and the main agent decides whether to spawn a follow-up task"
            >
              <MessageSquare className="h-3 w-3" />
              Follow up in main chat
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
            {timelineItems.length === 0 ? (
              <div className="mt-6 text-center text-xs text-[var(--text-muted)]">
                {state === 'running' ? 'Subagent starting…' : 'No activity to show yet.'}
              </div>
            ) : (
              timelineItems.map((item, idx) =>
                item.type === 'work' ? (
                  <ToolExecutionBatch
                    key={item.group.id}
                    messages={item.group.messages}
                    toolStatusMap={toolStatusMap}
                    toolResultsMap={toolResultsMap}
                    isSessionRunning={Boolean(sessionRunning)}
                    isLastBatch={false}
                    subagentMessagesByParent={subagentMessagesByParent}
                    defaultExpanded
                    resetKey={`${selected.id}:${item.group.id}`}
                  />
                ) : (
                  <MessageCard
                    key={`sub-${selected.id}-${item.originalIndex}-${idx}`}
                    sessionId={sessionId}
                    message={item.message}
                    toolStatusMap={toolStatusMap}
                    toolResultsMap={toolResultsMap}
                    subagentMessagesByParent={subagentMessagesByParent}
                  />
                )
              )
            )}
            {state === 'frozen' ? (
              <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-xs text-[var(--text-muted)]">
                This subagent moved to the background — further progress is not streamed here. Its final result will be reported back in the main chat.
              </div>
            ) : null}
            {state === 'running' ? (
              <div className="mt-3 flex items-center gap-2 text-xs text-[var(--text-muted)]">
                <Loader2 className="h-3 w-3 animate-spin" />
                Running…
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-[var(--text-muted)]">
          This subagent isn't part of the current session — switch back to its original session to view it.
        </div>
      )}
    </div>
  );
}

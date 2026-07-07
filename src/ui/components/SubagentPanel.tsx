import { useMemo } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';
import { Users, Loader2, MessageSquare } from './icons';
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
 * Single, per-session subagent detail panel (the reviewed design: one utility
 * tab, an internal list to switch between the session's subagents, read-only
 * full transcript of the selected one). No composer — following up goes to the
 * MAIN agent via a visible quote injected into the main composer, because the
 * SDK cannot address a running/finished subagent directly.
 */
export function SubagentPanel({
  collapsed,
  sessionId,
}: {
  collapsed: boolean;
  sessionId: string | null;
}) {
  const session = useAppStore((s) => (sessionId ? s.sessions[sessionId] ?? null : null));
  const { activeSubagentId, setActiveSubagentId, requestChatInjection } = useAppStore(
    useShallow((s) => ({
      activeSubagentId: s.activeSubagentId,
      setActiveSubagentId: s.setActiveSubagentId,
      requestChatInjection: s.requestChatInjection,
    }))
  );

  const summaries = useMemo(
    () => (session ? deriveSubagentSummaries(session.messages) : []),
    [session?.messages]
  );

  // Validate the selection against the current session's subagents — a
  // rewound-away or cross-session id falls back to the first available.
  const selectedId = useMemo(() => {
    if (activeSubagentId && summaries.some((s) => s.id === activeSubagentId)) {
      return activeSubagentId;
    }
    return summaries[0]?.id ?? null;
  }, [activeSubagentId, summaries]);
  const selected = summaries.find((s) => s.id === selectedId) ?? null;

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
      text: `关于「${label}」子智能体的工作:`,
      mode: 'append',
      source: 'subagent-panel',
    });
  };

  return (
    <div
      className="absolute inset-0 flex min-h-0 flex-col bg-[var(--bg-primary)]"
      data-subagent-panel
    >
      {/* Header + subagent switcher */}
      <div className="flex-shrink-0 border-b border-[var(--border)] px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-medium text-[var(--text-secondary)]">
          <Users className="h-3.5 w-3.5" />
          <span>子智能体</span>
          {summaries.length > 0 ? (
            <span className="text-[var(--text-muted)]">· {summaries.length}</span>
          ) : null}
        </div>
        {summaries.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {summaries.map((s) => {
              const st = displayState(s, Boolean(sessionRunning));
              const active = s.id === selectedId;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setActiveSubagentId(s.id)}
                  className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-1 text-xs transition-colors ${
                    active
                      ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-[var(--text-primary)]'
                      : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)]'
                  }`}
                  title={s.persona.functionalName}
                >
                  <StatusDot state={st} />
                  <span
                    className="h-2 w-2 flex-shrink-0 rounded-full"
                    style={{ backgroundColor: `hsl(${s.persona.colorHue} 55% 55%)` }}
                  />
                  <span className="truncate">{s.persona.functionalName}</span>
                  <span className="flex-shrink-0 text-[var(--text-muted)]">{s.persona.persona}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      {/* Selected subagent transcript */}
      {selected ? (
        <>
          <div className="flex flex-shrink-0 items-center justify-between gap-2 px-3 py-2 text-xs text-[var(--text-muted)]">
            <div className="flex items-center gap-2">
              <StatusDot state={state} />
              <span className="text-[var(--text-secondary)]">
                {state === 'running' ? '运行中' : state === 'error' ? '失败' : state === 'frozen' ? '已转入后台' : '已完成'}
              </span>
              {typeof selected.durationMs === 'number' ? (
                <span>· {formatDuration(selected.durationMs)}</span>
              ) : null}
            </div>
            <button
              type="button"
              onClick={handleFollowUp}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
              title="子智能体不能单独对话;这会在主对话里预填一条引用,由主 agent 决定是否再派子任务"
            >
              <MessageSquare className="h-3 w-3" />
              在主对话里跟进
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
            {timelineItems.length === 0 ? (
              <div className="mt-6 text-center text-xs text-[var(--text-muted)]">
                {state === 'running' ? '子智能体启动中…' : '暂无可显示的运行记录。'}
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
                此子智能体已转入后台,后续过程不再实时回传。最终结果会汇总到主对话。
              </div>
            ) : null}
            {state === 'running' ? (
              <div className="mt-3 flex items-center gap-2 text-xs text-[var(--text-muted)]">
                <Loader2 className="h-3 w-3 animate-spin" />
                运行中…
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-[var(--text-muted)]">
          本会话还没有子智能体。当主 agent 派生并行子任务时,它们会出现在这里。
        </div>
      )}
    </div>
  );
}

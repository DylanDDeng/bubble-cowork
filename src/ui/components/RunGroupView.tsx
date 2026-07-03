import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { RunGroupMemberSummary, RunGroupSummary } from '../../shared/types';
import { useAppStore } from '../store/useAppStore';
import { AgentIcon } from './ComposerAgentControls';
import { GitFork, X } from './icons';

function formatDuration(startedAt: number | null, updatedAt: number | null): string | null {
  if (!startedAt || !updatedAt || updatedAt <= startedAt) return null;
  const seconds = Math.round((updatedAt - startedAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function memberStatusLabel(member: RunGroupMemberSummary): string {
  if (member.phase === 'failed' && !member.sessionId) return 'failed';
  switch (member.sessionStatus) {
    case 'running':
      return 'running';
    case 'error':
      return 'failed';
    case 'idle':
    case 'completed':
      return 'done';
    default:
      return member.phase;
  }
}

function MemberCard({
  summary,
  member,
  adopting,
  onOpen,
  onAdopt,
}: {
  summary: RunGroupSummary;
  member: RunGroupMemberSummary;
  adopting: boolean;
  onOpen: (sessionId: string) => void;
  onAdopt: (sessionId: string) => void;
}) {
  const [diff, setDiff] = useState<string | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [loadingDiff, setLoadingDiff] = useState(false);

  const status = memberStatusLabel(member);
  const duration = formatDuration(member.startedAt, member.updatedAt);
  const isDone = status === 'done';
  const canAdopt =
    Boolean(member.sessionId && member.worktreePath) &&
    member.sessionStatus !== 'running' &&
    summary.group.status !== 'adopted' &&
    summary.group.status !== 'discarded';

  const toggleDiff = async () => {
    if (diffOpen) {
      setDiffOpen(false);
      return;
    }
    setDiffOpen(true);
    if (diff === null && !loadingDiff) {
      setLoadingDiff(true);
      try {
        const text = await window.electron.getRunGroupMemberDiff(summary.group.id, member.index);
        setDiff(text ?? '');
      } finally {
        setLoadingDiff(false);
      }
    }
  };

  return (
    <div className="flex min-w-0 flex-col rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] p-4">
      <div className="flex items-center gap-2">
        <AgentIcon provider={member.provider} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--text-primary)]">
          {member.provider}
          {member.model ? ` · ${member.model}` : ''}
        </span>
        <span
          className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
            status === 'running'
              ? 'bg-emerald-500/10 text-emerald-500'
              : status === 'failed'
                ? 'bg-rose-500/10 text-rose-500'
                : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
          }`}
        >
          {status}
          {duration && isDone ? ` · ${duration}` : ''}
        </span>
      </div>

      <div className="mt-2 flex items-center gap-3 text-[12px] text-[var(--text-secondary)]">
        {member.diffStat ? (
          <>
            <span>{member.diffStat.filesChanged + member.diffStat.untracked} files</span>
            <span className="text-emerald-500">+{member.diffStat.insertions}</span>
            <span className="text-rose-500">−{member.diffStat.deletions}</span>
            {member.diffStat.untracked > 0 ? (
              <span className="text-[var(--text-muted)]">{member.diffStat.untracked} new</span>
            ) : null}
          </>
        ) : member.failReason ? (
          <span className="truncate text-rose-500" title={member.failReason}>
            {member.failReason}
          </span>
        ) : (
          <span className="text-[var(--text-muted)]">no workspace</span>
        )}
        {member.branch ? (
          <span className="min-w-0 truncate text-[11px] text-[var(--text-muted)]" title={member.branch}>
            {member.branch}
          </span>
        ) : null}
      </div>

      {member.excerpt ? (
        <p className="mt-2 line-clamp-3 text-[12px] leading-relaxed text-[var(--text-secondary)]">
          {member.excerpt}
        </p>
      ) : null}

      <div className="mt-3 flex items-center gap-2">
        {member.sessionId ? (
          <button
            type="button"
            onClick={() => onOpen(member.sessionId!)}
            className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
          >
            Open thread
          </button>
        ) : null}
        {member.worktreePath && summary.group.baseRef ? (
          <button
            type="button"
            onClick={() => void toggleDiff()}
            className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
          >
            {diffOpen ? 'Hide diff' : 'View diff'}
          </button>
        ) : null}
        <span className="flex-1" />
        {canAdopt ? (
          <button
            type="button"
            disabled={adopting}
            onClick={() => member.sessionId && onAdopt(member.sessionId)}
            className="rounded-lg bg-[var(--text-primary)] px-3 py-1 text-[12px] font-medium text-[var(--bg-primary)] transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Adopt
          </button>
        ) : null}
      </div>

      {diffOpen ? (
        <div className="mt-3 max-h-[320px] overflow-auto rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-2">
          {loadingDiff ? (
            <div className="p-2 text-[12px] text-[var(--text-muted)]">Loading diff…</div>
          ) : diff ? (
            <pre className="whitespace-pre text-[11px] leading-relaxed text-[var(--text-secondary)]">
              {diff}
            </pre>
          ) : (
            <div className="p-2 text-[12px] text-[var(--text-muted)]">No changes.</div>
          )}
        </div>
      ) : null}
    </div>
  );
}

// Fan-out 比较视图（overlay）：并排看成员 diffstat/摘要，一键采纳赢家。
// 决策点 10 选的是 store 侧临时状态（不进 layout 树、不跨重启持久，三个入口可重开）。
export function RunGroupView() {
  const runGroupViewId = useAppStore((state) => state.runGroupViewId);
  const setRunGroupViewId = useAppStore((state) => state.setRunGroupViewId);
  const setActiveSession = useAppStore((state) => state.setActiveSession);
  const [summary, setSummary] = useState<RunGroupSummary | null>(null);
  const [adopting, setAdopting] = useState(false);

  const refresh = useCallback(async () => {
    if (!runGroupViewId) return;
    const next = await window.electron.getRunGroupSummary(runGroupViewId);
    setSummary(next);
  }, [runGroupViewId]);

  useEffect(() => {
    setSummary(null);
    if (!runGroupViewId) return;
    void refresh();
    const unsubscribe = window.electron.onServerEvent((event) => {
      if (event.type === 'runGroup.changed' && event.payload.group.id === runGroupViewId) {
        void refresh();
      }
    });
    return unsubscribe;
  }, [runGroupViewId, refresh]);

  if (!runGroupViewId) return null;

  const close = () => setRunGroupViewId(null);

  const openSession = (sessionId: string) => {
    close();
    setActiveSession(sessionId);
  };

  const adopt = async (sessionId: string) => {
    if (!summary) return;
    setAdopting(true);
    try {
      const result = await window.electron.adoptRunGroup(summary.group.id, sessionId);
      if (result.ok) {
        toast.success('Result adopted — changes are staged in your main workspace for review.');
        void refresh();
      } else {
        toast.error(result.message || 'Adoption failed.');
      }
    } finally {
      setAdopting(false);
    }
  };

  const discard = async () => {
    if (!summary) return;
    const result = await window.electron.discardRunGroup(summary.group.id);
    if (result.ok) {
      toast.success('Fan-out discarded; worktrees cleaned up.');
      close();
    } else {
      toast.error(result.message || 'Discard failed.');
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-6" onClick={close}>
      <div
        className="flex max-h-[85vh] w-full max-w-[960px] flex-col overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-secondary)] shadow-[0_24px_80px_rgba(0,0,0,0.35)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-[var(--border)] px-5 py-3.5">
          <GitFork className="h-4 w-4 flex-shrink-0 text-[var(--text-muted)]" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-[var(--text-primary)]">
              {summary?.group.prompt || 'Fan-out'}
            </div>
            <div className="text-[11px] text-[var(--text-muted)]">
              {summary
                ? `${summary.members.length} agents · ${summary.group.status}${
                    summary.group.baseRef ? ` · base ${summary.group.baseRef.slice(0, 8)}` : ''
                  }`
                : 'Loading…'}
            </div>
          </div>
          {summary && summary.group.status !== 'adopted' && summary.group.status !== 'discarded' ? (
            <button
              type="button"
              onClick={() => void discard()}
              className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-rose-500"
            >
              Discard all
            </button>
          ) : null}
          <button
            type="button"
            onClick={close}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid flex-1 gap-3 overflow-y-auto p-5 sm:grid-cols-2">
          {summary?.members.map((member) => (
            <MemberCard
              key={member.index}
              summary={summary}
              member={member}
              adopting={adopting}
              onOpen={openSession}
              onAdopt={(sessionId) => void adopt(sessionId)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

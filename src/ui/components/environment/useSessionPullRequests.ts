import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { SessionPullRequest, SessionPullRequestView } from '../../../shared/types';
import type { ActiveEnvironmentContext } from './useActiveEnvironmentContext';
import type { GitEnvironmentState } from './useGitEnvironment';

export function useSessionPullRequests(context: ActiveEnvironmentContext, git: GitEnvironmentState) {
  const sessionId = context.isDraft || context.isDm ? null : context.sessionId;
  const activeSession = useRef(sessionId);
  activeSession.current = sessionId;
  const sequence = useRef(0);
  const lastGitRefresh = useRef({ sessionId, at: git.lastUpdatedAt });
  const [state, setState] = useState<{ sessionId: string | null; items: SessionPullRequestView[]; error: string | null }>({ sessionId: null, items: [], error: null });
  const [busy, setBusy] = useState<string | null>(null);
  const available = typeof window.electron.listSessionPullRequests === 'function';
  const refresh = useCallback(async (remote = true) => {
    if (!sessionId || !available) return;
    const request = ++sequence.current;
    try {
      const items = await window.electron.listSessionPullRequests(sessionId, remote);
      if (sequence.current === request && activeSession.current === sessionId) setState({ sessionId, items, error: null });
    } catch {
      if (sequence.current === request && activeSession.current === sessionId) {
        setState(old => ({ sessionId, items: old.sessionId === sessionId ? old.items : [], error: 'Could not load task pull requests.' }));
      }
    }
  }, [sessionId, available]);

  useEffect(() => {
    let cancelled = false;
    void refresh(false).then(() => { if (!cancelled) void refresh(); });
    const unsubscribe = available ? window.electron.onSessionPullRequestsChanged(id => {
      if (id === sessionId) void refresh();
    }) : undefined;
    return () => { cancelled = true; sequence.current++; unsubscribe?.(); };
  }, [refresh, sessionId, available]);

  useEffect(() => {
    const previous = lastGitRefresh.current;
    lastGitRefresh.current = { sessionId, at: git.lastUpdatedAt };
    // The session effect already performs its initial cached and remote reads.
    if (previous.sessionId === sessionId && previous.at !== git.lastUpdatedAt) void refresh();
  }, [sessionId, git.lastUpdatedAt, refresh]);

  const detach = useCallback(async (pr: SessionPullRequest, targetSessionId = sessionId) => {
    if (!targetSessionId) return;
    setBusy(targetSessionId);
    try {
      await window.electron.detachSessionPullRequest(targetSessionId, pr.url, pr.attachedAt);
      if (activeSession.current === targetSessionId) await refresh();
    } catch {
      toast.error('Could not remove the pull request association.');
    } finally { setBusy(current => current === targetSessionId ? null : current); }
  }, [sessionId, refresh]);

  const attach = useCallback(async (url: string) => {
    const snapshot = git.getSnapshot();
    if (!sessionId || !available || !snapshot.cwd || !snapshot.repoRoot || !snapshot.branch) return;
    setBusy(sessionId);
    try {
      const result = await window.electron.attachSessionPullRequest({ sessionId, cwd: snapshot.cwd, repoRoot: snapshot.repoRoot, headBranch: snapshot.branch, url });
      if (result.created) toast.success('Pull request associated with this task.', {
        action: { label: 'Undo', onClick: () => { void detach(result.pr, sessionId); } },
      });
      if (activeSession.current === sessionId) await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not associate the pull request.');
    } finally { setBusy(current => current === sessionId ? null : current); }
  }, [sessionId, available, git, detach, refresh]);

  return {
    items: state.sessionId === sessionId ? state.items : [],
    error: state.sessionId === sessionId ? state.error : null,
    busy: busy === sessionId && busy !== null,
    canAttach: available && !!sessionId && !context.unavailableReason && busy !== sessionId,
    refresh, attach, detach,
  };
}

export type SessionPullRequestsState = ReturnType<typeof useSessionPullRequests>;

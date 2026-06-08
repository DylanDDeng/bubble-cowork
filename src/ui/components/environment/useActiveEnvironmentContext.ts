import { useMemo } from 'react';
import { useAppStore } from '../../store/useAppStore';
import type { ChatPaneId, SessionView } from '../../types';

export interface ActiveEnvironmentContext {
  paneId: ChatPaneId;
  paneLabel: string;
  sessionId: string | null;
  session: SessionView | null;
  title: string;
  projectCwd: string | null;
  effectiveCwd: string | null;
  envMode: 'local' | 'worktree';
  worktreePath: string | null;
  isRunning: boolean;
  isDraft: boolean;
  isDm: boolean;
  contextKey: string;
  unavailableReason: string | null;
}

function paneLabelFor(paneId: ChatPaneId): string {
  return paneId === 'secondary' ? 'Right pane' : 'Left pane';
}

export function buildEnvironmentContextSnapshot(context: ActiveEnvironmentContext) {
  return {
    paneId: context.paneId,
    sessionId: context.sessionId,
    cwd: context.effectiveCwd,
    contextKey: context.contextKey,
  };
}

export function useActiveEnvironmentContext(): ActiveEnvironmentContext {
  const {
    activePaneId,
    activeSessionId,
    chatPanes,
    sessions,
    projectCwd,
  } = useAppStore();

  return useMemo(() => {
    const paneId = activePaneId || 'primary';
    const paneSessionId = chatPanes[paneId]?.sessionId || null;
    const sessionId = paneSessionId || activeSessionId || null;
    const session = sessionId ? sessions[sessionId] || null : null;
    const resolvedProjectCwd = session?.projectCwd || session?.cwd || projectCwd || null;
    const effectiveCwd = session?.worktreePath || session?.cwd || resolvedProjectCwd || null;
    const envMode = session?.envMode === 'worktree' && session?.worktreePath ? 'worktree' : 'local';
    const isDraft = Boolean(session?.isDraft);
    const isDm = session?.scope === 'dm';
    const unavailableReason =
      !session
        ? 'No active thread in this pane.'
        : isDraft
          ? 'Draft threads do not have a stable environment yet.'
          : isDm
            ? 'Direct-message threads do not use a project environment.'
            : !effectiveCwd
              ? 'No workspace path is available for this thread.'
              : null;

    return {
      paneId,
      paneLabel: paneLabelFor(paneId),
      sessionId,
      session,
      title: session?.title || 'Untitled thread',
      projectCwd: resolvedProjectCwd,
      effectiveCwd,
      envMode,
      worktreePath: session?.worktreePath || null,
      isRunning: session?.status === 'running',
      isDraft,
      isDm,
      contextKey: [
        paneId,
        sessionId || 'no-session',
        effectiveCwd || 'no-cwd',
        envMode,
        session?.worktreePath || '',
      ].join(':'),
      unavailableReason,
    };
  }, [activePaneId, activeSessionId, chatPanes, projectCwd, sessions]);
}

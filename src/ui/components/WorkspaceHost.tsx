import { ArrowLeftRight, Columns2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { ChatPane } from './ChatPane';

export function WorkspaceHost({
  codexModelConfig,
}: {
  codexModelConfig: import('../types').CodexModelConfig;
}) {
  const {
    chatLayoutMode,
    activeSessionId,
    activePaneId,
    chatPanes,
    chatSplitRatio,
    setActivePane,
    closeSplitChat,
    setChatPaneSession,
    setChatSplitRatio,
    swapChatPanes,
  } = useAppStore();
  const [dragTarget, setDragTarget] = useState<'primary' | 'secondary' | null>(null);
  const resizingRef = useRef(false);
  const startXRef = useRef(0);
  const startRatioRef = useRef(chatSplitRatio);

  const primaryBasis = useMemo(() => `${chatSplitRatio * 100}%`, [chatSplitRatio]);
  const secondaryBasis = useMemo(() => `${(1 - chatSplitRatio) * 100}%`, [chatSplitRatio]);

  const applyDroppedSession = (paneId: 'primary' | 'secondary', sessionId: string) => {
    const currentPrimary =
      chatLayoutMode === 'single'
        ? activeSessionId
        : chatPanes.primary.sessionId;

    if (chatLayoutMode === 'single') {
      useAppStore.setState({
        chatLayoutMode: 'split',
        savedSplitVisible: true,
        activePaneId: paneId,
        activeSessionId: sessionId,
        showNewSession: false,
        chatPanes: {
          primary: {
            id: 'primary',
            sessionId: paneId === 'primary' ? sessionId : currentPrimary,
            surface: 'chat',
          },
          secondary: {
            id: 'secondary',
            sessionId:
              paneId === 'secondary'
                ? sessionId
                : currentPrimary && currentPrimary !== sessionId
                  ? currentPrimary
                  : null,
            surface: 'chat',
          },
        },
      });

      const nextState = useAppStore.getState();
      void window.electron.saveUiResumeState({
        activeSessionId: nextState.activeSessionId,
        showNewSession: nextState.showNewSession,
        projectCwd: nextState.projectCwd,
        projectTreeCollapsed: nextState.projectTreeCollapsed,
        projectPanelView: nextState.projectPanelView,
        terminalDrawerOpen: nextState.terminalDrawerOpen,
        terminalDrawerHeight: nextState.terminalDrawerHeight,
        chatLayoutMode: nextState.chatLayoutMode,
        activePaneId: nextState.activePaneId,
        chatPanes: nextState.chatPanes,
        chatSplitRatio: nextState.chatSplitRatio,
      });
      return;
    }

    setChatPaneSession(paneId, sessionId);
  };

  const startResize = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizingRef.current = true;
    startXRef.current = event.clientX;
    startRatioRef.current = chatSplitRatio;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handleMove = (moveEvent: MouseEvent) => {
      if (!resizingRef.current) return;
      const parent = event.currentTarget.parentElement as HTMLDivElement | null;
      if (!parent) return;
      const delta = moveEvent.clientX - startXRef.current;
      const nextRatio = startRatioRef.current + delta / parent.clientWidth;
      setChatSplitRatio(nextRatio);
    };

    const finish = () => {
      resizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', finish);
      window.removeEventListener('blur', finish);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', finish, { once: true });
    window.addEventListener('blur', finish, { once: true });
  };

  const secondaryControls =
    chatLayoutMode === 'split' ? (
      <>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            swapChatPanes();
          }}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
          aria-label="Swap panes"
          title="Swap panes"
        >
          <ArrowLeftRight className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            closeSplitChat();
          }}
          className="inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11px] text-[var(--text-muted)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
          aria-label="Close split view"
          title="Close split view"
        >
          <Columns2 className="h-3.5 w-3.5" />
          <span>Single</span>
        </button>
      </>
    ) : null;

  const renderPane = (paneId: 'primary' | 'secondary') => {
    const pane = chatPanes[paneId];
    const isActive = activePaneId === paneId;

    return (
      <ChatPane
        paneId={paneId}
        sessionId={pane.sessionId}
        isActive={isActive}
        onActivate={() => setActivePane(paneId)}
        codexModelConfig={codexModelConfig}
        dropHint={dragTarget === paneId ? `Open in ${paneId === 'primary' ? 'left' : 'right'} pane` : null}
        onDropSession={(sessionId) => {
          setDragTarget(null);
          applyDroppedSession(paneId, sessionId);
        }}
        onClose={paneId === 'secondary' && chatLayoutMode === 'split' ? closeSplitChat : undefined}
        headerActions={paneId === 'secondary' ? secondaryControls : null}
      />
    );
  };

  if (chatLayoutMode === 'single') {
    return (
      <div
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
        onDragLeave={() => setDragTarget(null)}
        onDragOver={(event) => {
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          setDragTarget(event.clientX - bounds.left < bounds.width / 2 ? 'primary' : 'secondary');
        }}
        onDrop={(event) => {
          const sessionId = event.dataTransfer.getData('application/x-aegis-session-id');
          if (!sessionId) return;
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          const targetPane = event.clientX - bounds.left < bounds.width / 2 ? 'primary' : 'secondary';
          setDragTarget(null);
          applyDroppedSession(targetPane, sessionId);
        }}
      >
        <ChatPane
          paneId="primary"
          sessionId={activeSessionId}
          isActive={activePaneId === 'primary'}
          onActivate={() => setActivePane('primary')}
          codexModelConfig={codexModelConfig}
          dropHint={dragTarget === 'primary' ? 'Open on left' : null}
        />
        {dragTarget === 'secondary' ? (
          <div className="pointer-events-none absolute inset-y-0 right-0 z-10 flex w-1/2 items-center justify-center rounded-l-[var(--radius-2xl)] border-2 border-dashed border-[color-mix(in_srgb,var(--accent)_30%,transparent)] bg-[color-mix(in_srgb,var(--accent-light)_75%,transparent)] text-sm font-medium text-[var(--text-primary)]">
            Open on right
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div
        className="min-h-0 min-w-0 flex flex-col overflow-hidden"
        style={{ flexBasis: primaryBasis, flexGrow: 0, flexShrink: 0 }}
      >
        {renderPane('primary')}
      </div>
      <div
        className="group relative z-10 w-2 shrink-0 cursor-col-resize bg-transparent"
        onMouseDown={startResize}
        onDragOver={(event) => {
          event.preventDefault();
          setDragTarget(null);
        }}
      >
        <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[var(--border)] transition-colors group-hover:bg-[var(--accent)]/40" />
      </div>
      <div
        className="min-h-0 min-w-0 flex flex-1 flex-col overflow-hidden"
        style={{ flexBasis: secondaryBasis }}
      >
        {renderPane('secondary')}
      </div>
    </div>
  );
}

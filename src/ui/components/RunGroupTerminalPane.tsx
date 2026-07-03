import { useMemo } from 'react';
import { useAppStore } from '../store/useAppStore';
import { TerminalViewportPane } from '../terminal/TerminalViewportPane';
import type { TerminalRuntimeConfig } from '../terminal/terminalRuntimeTypes';
import { SquareTerminal, X } from './icons';

// Fan-out custom（终端）成员的树内 pane：附着到主进程已启动的 PTY（回放历史 +
// 实时输出）。关闭 pane 只是收起视图——PTY 继续跑，从侧栏 Fan-outs 可随时重开。
export function RunGroupTerminalPane({
  threadId,
  isActive,
  onActivate,
  onClose,
}: {
  threadId: string;
  isActive: boolean;
  onActivate: () => void;
  onClose?: () => void;
}) {
  const paneInfo = useAppStore((state) => state.runGroupTerminalPanes[threadId]);

  const config = useMemo<TerminalRuntimeConfig | null>(() => {
    if (!paneInfo) return null;
    return {
      runtimeKey: `rg-term-${threadId}`,
      threadId,
      terminalId: 'default',
      cwd: paneInfo.cwd,
      agentKind: 'shell',
    };
  }, [paneInfo, threadId]);

  return (
    <div
      className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--bg-primary)] ${
        isActive ? '' : 'opacity-95'
      }`}
      onMouseDown={onActivate}
    >
      <div className="flex h-9 flex-shrink-0 items-center gap-2 border-b border-[var(--border)] px-3">
        <SquareTerminal className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
        <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-secondary)]">
          {paneInfo?.title || threadId}
        </span>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
            title="Hide terminal (the run keeps going)"
            aria-label="Hide terminal"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      {config ? (
        <div className="min-h-0 flex-1">
          <TerminalViewportPane
            config={config}
            viewState={{ isVisible: true, isActive }}
          />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-[12px] text-[var(--text-muted)]">
          This terminal run has ended or is from a previous session.
          <br />
          Reopen members from the Fan-outs list in the sidebar.
        </div>
      )}
    </div>
  );
}

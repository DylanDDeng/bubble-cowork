import { useEffect, useRef, useState, type ReactNode } from 'react';
import { SquareTerminal, X } from './icons';
import { SessionTerminal } from './SessionTerminal';

const MIN_PANEL_WIDTH = 360;
const MAX_PANEL_WIDTH = 960;

export function RightTerminalPanel({
  collapsed,
  width,
  onWidthChange,
  onClose,
  sessionId,
  cwd,
  header,
}: {
  collapsed: boolean;
  width: number;
  onWidthChange: (width: number) => void;
  onClose: () => void;
  sessionId: string | null;
  cwd: string | null;
  header?: ReactNode;
}) {
  const [isResizing, setIsResizing] = useState(false);
  const [terminalMounted, setTerminalMounted] = useState(!collapsed);
  const resizingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);
  const terminalScopeId = sessionId ? `${sessionId}:right-terminal` : cwd ? `project:${cwd}:right-terminal` : null;

  useEffect(() => {
    if (!collapsed) {
      setTerminalMounted(true);
    }
  }, [collapsed]);

  useEffect(() => {
    if (!isResizing) return;
    const onMove = (event: MouseEvent) => {
      if (!resizingRef.current) return;
      const delta = startXRef.current - event.clientX;
      const next = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, startWidthRef.current + delta));
      onWidthChange(next);
    };
    const onUp = () => {
      resizingRef.current = false;
      setIsResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onUp);
    };
  }, [isResizing, onWidthChange]);

  const handleResizeStart = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizingRef.current = true;
    startXRef.current = event.clientX;
    startWidthRef.current = width;
    setIsResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <div
      className={`relative flex h-full flex-col border-l border-[var(--border)] bg-[var(--bg-primary)] transition-[width,opacity,transform,border-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
        collapsed ? 'pointer-events-none' : ''
      }`}
      style={{
        width: collapsed ? 0 : width,
        opacity: collapsed ? 0 : 1,
        transform: collapsed ? 'translateX(18px)' : 'translateX(0)',
        borderLeftWidth: collapsed ? 0 : 1,
      }}
      aria-hidden={collapsed}
    >
      {!collapsed ? (
        <div
          className="group absolute bottom-0 left-0 top-0 z-10 w-3 -translate-x-1/2 cursor-col-resize no-drag"
          onMouseDown={handleResizeStart}
        >
          <div className="absolute bottom-0 left-1/2 top-0 w-px -translate-x-1/2 bg-transparent group-hover:bg-[var(--border)]" />
        </div>
      ) : null}

      {header ? (
        header
      ) : (
        <>
          <div className="h-8 drag-region flex-shrink-0" />
          <div className="drag-region flex h-9 shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--bg-primary)] px-3">
            <div className="flex min-w-0 items-center gap-2 text-[12px] font-medium text-[var(--text-secondary)]">
              <SquareTerminal className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">Terminal</span>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="no-drag inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
              aria-label="Hide right terminal"
              title="Hide terminal"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </>
      )}

      <div className="min-h-0 flex-1">
        {terminalMounted ? (
          <SessionTerminal
            sessionId={sessionId}
            cwd={cwd}
            terminalScopeId={terminalScopeId}
            visible={!collapsed}
            onRequestClose={onClose}
            hideChromeTabs={Boolean(header)}
          />
        ) : null}
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2, Minus, SquareTerminal, X } from './icons';
import { SessionTerminal } from './SessionTerminal';

const MIN_DRAWER_HEIGHT = 180;
const MAX_DRAWER_HEIGHT = 640;

export function TerminalDrawer({
  open,
  height,
  onHeightChange,
  fullscreen,
  onFullscreenChange,
  onClose,
  sessionId,
  cwd,
}: {
  open: boolean;
  height: number;
  onHeightChange: (height: number) => void;
  fullscreen: boolean;
  onFullscreenChange: (fullscreen: boolean) => void;
  onClose: () => void;
  sessionId: string | null;
  cwd: string | null;
}) {
  const latestHeightRef = useRef(height);
  const startYRef = useRef(0);
  const startHeightRef = useRef(height);
  const resizingRef = useRef(false);
  const [isResizing, setIsResizing] = useState(false);
  const [terminalMounted, setTerminalMounted] = useState(open);

  useEffect(() => {
    latestHeightRef.current = height;
  }, [height]);

  useEffect(() => {
    if (open) {
      setTerminalMounted(true);
    }
  }, [open]);

  useEffect(() => {
    if (!isResizing || fullscreen) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (!resizingRef.current) {
        return;
      }

      const delta = startYRef.current - event.clientY;
      const nextHeight = Math.min(
        Math.min(MAX_DRAWER_HEIGHT, Math.floor(window.innerHeight * 0.6)),
        Math.max(MIN_DRAWER_HEIGHT, startHeightRef.current + delta)
      );
      onHeightChange(nextHeight);
    };

    const finishResize = () => {
      resizingRef.current = false;
      setIsResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', finishResize, { once: true });
    window.addEventListener('blur', finishResize, { once: true });

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', finishResize);
      window.removeEventListener('blur', finishResize);
    };
  }, [fullscreen, isResizing, onHeightChange]);

  const startResize = (event: React.MouseEvent) => {
    if (fullscreen) {
      return;
    }

    event.preventDefault();
    resizingRef.current = true;
    setIsResizing(true);
    startYRef.current = event.clientY;
    startHeightRef.current = latestHeightRef.current;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  };

  const panelClass = fullscreen
    ? `absolute inset-0 z-40 flex min-h-0 flex-col overflow-hidden border-t border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_-20px_60px_rgba(0,0,0,0.14)] transition-[transform,opacity] duration-200 ease-out ${
        open ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-full opacity-0'
      }`
    : `shrink-0 overflow-hidden border-t border-[var(--border)] bg-[var(--bg-primary)] transition-[height,opacity] duration-200 ${
        open ? 'opacity-100' : 'pointer-events-none opacity-0'
      }`;

  return (
    <>
      {isResizing && !fullscreen ? <div className="fixed inset-0 z-[70] cursor-row-resize no-drag bg-transparent" /> : null}
      <div
        className={panelClass}
        style={fullscreen ? undefined : { height: open ? height : 0 }}
        aria-hidden={!open}
      >
        <div className="flex h-full min-h-0 flex-col">
          {!fullscreen ? (
            <div
              className="group relative h-3 shrink-0 cursor-row-resize no-drag"
              onMouseDown={startResize}
            >
              <div className="absolute left-1/2 top-1/2 flex h-3 w-12 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-[var(--bg-primary)] text-[var(--text-muted)] transition-colors group-hover:text-[var(--text-secondary)]">
                <Minus className="h-3.5 w-3.5" />
              </div>
            </div>
          ) : null}

          <div className="drag-region flex h-9 shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--bg-primary)] px-3">
            <div className="flex min-w-0 items-center gap-2 text-[12px] font-medium text-[var(--text-secondary)]">
              <SquareTerminal className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">Terminal</span>
            </div>
            <div className="no-drag flex items-center gap-1">
              <button
                type="button"
                onClick={() => onFullscreenChange(!fullscreen)}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
                aria-label={fullscreen ? 'Exit terminal fullscreen' : 'Enter terminal fullscreen'}
                title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              >
                {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
                aria-label="Hide terminal"
                title="Hide terminal"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1">
            {terminalMounted ? (
              <SessionTerminal
                sessionId={sessionId}
                cwd={cwd}
                visible={open}
                onRequestClose={onClose}
              />
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}

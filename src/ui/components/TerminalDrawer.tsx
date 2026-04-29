import { useEffect, useRef, useState } from 'react';
import { Minus } from 'lucide-react';
import { SessionTerminal } from './SessionTerminal';

const MIN_DRAWER_HEIGHT = 180;
const MAX_DRAWER_HEIGHT = 640;

export function TerminalDrawer({
  open,
  height,
  onHeightChange,
  onClose,
  sessionId,
  cwd,
}: {
  open: boolean;
  height: number;
  onHeightChange: (height: number) => void;
  onClose: () => void;
  sessionId: string | null;
  cwd: string | null;
}) {
  const latestHeightRef = useRef(height);
  const startYRef = useRef(0);
  const startHeightRef = useRef(height);
  const resizingRef = useRef(false);
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    latestHeightRef.current = height;
  }, [height]);

  useEffect(() => {
    if (!isResizing) {
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
  }, [isResizing, onHeightChange]);

  const startResize = (event: React.MouseEvent) => {
    event.preventDefault();
    resizingRef.current = true;
    setIsResizing(true);
    startYRef.current = event.clientY;
    startHeightRef.current = latestHeightRef.current;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <>
      {isResizing ? <div className="fixed inset-0 z-[70] cursor-row-resize no-drag bg-transparent" /> : null}
      <div
        className={`shrink-0 overflow-hidden bg-[var(--bg-primary)] transition-[height,opacity] duration-200 ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        style={{ height: open ? height : 0 }}
      >
        <div
          className="group relative h-3 cursor-row-resize no-drag"
          onMouseDown={startResize}
        >
          <div className="absolute left-1/2 top-1/2 flex h-3 w-12 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-[var(--bg-primary)] text-[var(--text-muted)] transition-colors group-hover:text-[var(--text-secondary)]">
            <Minus className="h-3.5 w-3.5" />
          </div>
        </div>
        <div className="h-[calc(100%-12px)] min-h-0">
          {open ? (
            <SessionTerminal
              sessionId={sessionId}
              cwd={cwd}
              onRequestClose={onClose}
            />
          ) : null}
        </div>
      </div>
    </>
  );
}

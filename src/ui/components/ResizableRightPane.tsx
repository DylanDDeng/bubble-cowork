import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { animate, motion, useMotionValue, usePresence, useTransform } from 'motion/react';
import { useAppReducedMotion } from '../hooks/useAppReducedMotion';
import { RIGHT_PANEL_MIN_WIDTH } from '../utils/right-panel-width';

/** Only commit the preferred width after a gesture. Live geometry stays local
 * to Motion; embedded editors, terminals and browser views observe their DOM. */
export function ResizableRightPane({
  width,
  maximumWidth,
  defaultWidth = 820,
  hidden,
  instantReveal,
  fullscreen,
  resizable = true,
  onWidthChange,
  children,
  activePanel,
}: {
  width: number;
  maximumWidth: number;
  defaultWidth?: number;
  hidden: boolean;
  instantReveal: boolean;
  fullscreen: boolean;
  resizable?: boolean;
  onWidthChange: (width: number) => void;
  children: ReactNode;
  activePanel: string | null;
}) {
  const minimumWidth = Math.min(RIGHT_PANEL_MIN_WIDTH, maximumWidth);
  const clamp = (value: number) =>
    Math.min(maximumWidth, Math.max(minimumWidth, Math.round(value)));
  const paneWidth = useMotionValue(width);
  const progress = useMotionValue(hidden ? 0 : instantReveal ? 1 : 0);
  const displayedWidth = useTransform(
    [paneWidth, progress],
    ([size, open]: number[]) => size * open,
  );
  const [isPresent, safeToRemove] = usePresence();
  const reducedMotion = useAppReducedMotion();
  const [isResizing, setIsResizing] = useState(false);
  const paneRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const cancelDragRef = useRef<(() => void) | null>(null);
  const wasFullscreenRef = useRef(fullscreen);

  useLayoutEffect(() => {
    // External geometry/mode changes end a gesture without overwriting the
    // saved preference with a width forced by a smaller window.
    cancelDragRef.current?.();
    paneWidth.set(width);
  }, [width, maximumWidth, fullscreen, hidden, resizable, isPresent, paneWidth]);

  useLayoutEffect(() => {
    const immediate = instantReveal || fullscreen || wasFullscreenRef.current || reducedMotion;
    wasFullscreenRef.current = fullscreen;
    const controls = animate(progress, hidden || !isPresent ? 0 : 1, {
      ...(immediate ? { duration: 0 } : { type: 'spring' as const, duration: 0.3, bounce: 0 }),
      onComplete: () => {
        if (!isPresent) safeToRemove?.();
      },
    });
    return () => controls.stop();
  }, [hidden, isPresent, fullscreen, instantReveal, reducedMotion, progress, safeToRemove]);

  useLayoutEffect(() => () => cancelDragRef.current?.(), []);

  // Keep accessible values current without re-rendering the application for
  // every pointer event.
  useLayoutEffect(
    () =>
      paneWidth.on('change', (value) => {
        handleRef.current?.setAttribute('aria-valuenow', String(Math.round(value)));
      }),
    [paneWidth],
  );

  const commitWidth = (value: number) => {
    const next = clamp(value);
    paneWidth.set(next);
    onWidthChange(next);
  };

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      event.button !== 0 ||
      !event.isPrimary ||
      cancelDragRef.current ||
      hidden ||
      fullscreen ||
      !resizable
    )
      return;
    event.preventDefault();
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = paneRef.current?.getBoundingClientRect().width ?? paneWidth.get();
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    let moved = false;
    progress.stop();
    progress.set(1);
    paneWidth.set(startWidth);
    target.setPointerCapture(pointerId);
    setIsResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      next.preventDefault();
      if (next.clientX !== startX) moved = true;
      paneWidth.set(clamp(startWidth + startX - next.clientX));
    };
    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', blur);
      target.removeEventListener('lostpointercapture', lostCapture);
      cancelDragRef.current = null;
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      setIsResizing(false);
      if (commit && moved) onWidthChange(paneWidth.get());
      else paneWidth.set(width);
    };
    const up = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      move(next);
      finish(true);
    };
    // Cancellation has no reliable final coordinates; retain the last width.
    const cancel = (next: PointerEvent) => {
      if (next.pointerId === pointerId) finish(true);
    };
    const lostCapture = (next: PointerEvent) => {
      if (next.pointerId === pointerId) finish(true);
    };
    const blur = () => finish(true);
    cancelDragRef.current = () => finish(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', blur);
    target.addEventListener('lostpointercapture', lostCapture);
  };

  return (
    <motion.div
      ref={paneRef}
      data-right-utility-workspace
      data-active-panel={activePanel ?? 'none'}
      data-resizing={isResizing || undefined}
      aria-hidden={hidden || !isPresent}
      inert={hidden || !isPresent}
      className={`relative flex h-full min-w-0 flex-col overflow-visible ${fullscreen ? 'flex-1' : 'flex-shrink-0'}`}
      style={{
        width: fullscreen ? 'auto' : displayedWidth,
        pointerEvents: hidden || !isPresent ? 'none' : undefined,
      }}
    >
      {!fullscreen && !hidden && isPresent && resizable && (
        <div
          ref={handleRef}
          role="separator"
          aria-label="Resize workspace panes"
          aria-orientation="vertical"
          aria-valuemin={minimumWidth}
          aria-valuemax={maximumWidth}
          aria-valuenow={Math.round(paneWidth.get())}
          tabIndex={0}
          className="group absolute inset-y-0 left-0 z-40 w-4 -translate-x-1/2 touch-none select-none cursor-col-resize no-drag outline-none"
          onPointerDown={startResize}
          onDoubleClick={() => commitWidth(defaultWidth)}
          onKeyDown={(event) => {
            const next =
              event.key === 'ArrowLeft'
                ? paneWidth.get() + 10
                : event.key === 'ArrowRight'
                  ? paneWidth.get() - 10
                  : event.key === 'Home'
                    ? minimumWidth
                    : event.key === 'End'
                      ? maximumWidth
                      : null;
            if (next === null) return;
            event.preventDefault();
            event.stopPropagation();
            commitWidth(next);
          }}
        >
          <div
            className={`pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 group-hover:bg-[var(--border)] group-focus-visible:bg-[var(--accent)] ${isResizing ? 'bg-[var(--accent)]' : 'bg-transparent'}`}
          />
        </div>
      )}
      <div className="absolute inset-0 overflow-hidden">
        <motion.div
          className="absolute inset-y-0 left-0 flex min-h-0 flex-col overflow-hidden border-l border-[var(--border)] bg-[var(--utility-pane-surface)] backdrop-[var(--utility-pane-backdrop)] [contain:layout_paint]"
          style={{ width: fullscreen ? '100%' : paneWidth }}
        >
          {children}
        </motion.div>
      </div>
    </motion.div>
  );
}

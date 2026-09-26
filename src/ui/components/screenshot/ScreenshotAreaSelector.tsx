import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { screenshotRectFromPoints, type ScreenshotRect } from '../../../shared/screenshot';

/** Select inside Aegis without requiring system Screen Recording permission. */
export function ScreenshotAreaSelector({ onComplete }: { onComplete: (rect: ScreenshotRect | null) => void }) {
  const layer = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const [rect, setRect] = useState<ScreenshotRect | null>(null);

  useEffect(() => {
    const previous = document.activeElement;
    layer.current?.focus();
    const key = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape') onComplete(null);
    };
    const cancel = () => onComplete(null);
    window.addEventListener('keydown', key, true);
    window.addEventListener('resize', cancel);
    return () => {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', cancel);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [onComplete]);

  const selectionAt = (x: number, y: number) => screenshotRectFromPoints(
    start.current!, { x, y }, { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }
  );

  return createPortal(
    <div
      ref={layer}
      role="dialog"
      aria-modal="true"
      aria-label="Select screenshot area"
      aria-describedby="screenshot-area-instructions"
      tabIndex={-1}
      data-screenshot-area-selector
      className="no-drag fixed inset-0 cursor-crosshair select-none outline-none"
      style={{ zIndex: 2147483647, touchAction: 'none' }}
      onContextMenu={event => event.preventDefault()}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = { x: event.clientX, y: event.clientY };
        setRect(selectionAt(event.clientX, event.clientY));
      }}
      onPointerMove={event => {
        if (start.current) setRect(selectionAt(event.clientX, event.clientY));
      }}
      onPointerUp={event => {
        if (!start.current || event.button !== 0) return;
        const selected = selectionAt(event.clientX, event.clientY);
        start.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        if (selected.width >= 2 && selected.height >= 2) onComplete(selected);
        else setRect(null);
      }}
      onPointerCancel={() => { start.current = null; setRect(null); }}
    >
      {rect ? (
        <div className="pointer-events-none absolute border border-white" style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height, boxShadow: '0 0 0 99999px rgba(0,0,0,0.35)' }} />
      ) : <div className="pointer-events-none absolute inset-0 bg-black/35" />}
      <div id="screenshot-area-instructions" className="pointer-events-none absolute left-1/2 top-10 -translate-x-1/2 rounded-lg bg-black/80 px-4 py-2 text-[13px] text-white shadow-lg">
        Drag to capture an area · Esc to cancel
      </div>
    </div>,
    document.body
  );
}

import { useEffect, useRef } from 'react';
import { terminalHost, type TerminalSpec } from './terminal-host';

const SETTLE_REFIT_MS = 220;

export function TerminalViewportPane({
  spec,
  visible,
  active,
}: {
  spec: TerminalSpec;
  visible: boolean;
  active: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const specRef = useRef(spec);
  specRef.current = spec;
  const viewRef = useRef({ visible, active });
  viewRef.current = { visible, active };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    terminalHost.mount(specRef.current, viewRef.current, container);
    return () => terminalHost.unmount(spec.key);
  }, [spec.key]);

  useEffect(() => {
    terminalHost.update(spec);
  }, [spec]);

  useEffect(() => {
    terminalHost.show(spec.key, { visible, active });
  }, [spec.key, visible, active]);

  // Pane size changes: refit on the next frame and once more after layout
  // animations settle.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let frame: number | null = null;
    let settle: number | null = null;
    const onResize = () => {
      if (frame === null) {
        frame = window.requestAnimationFrame(() => {
          frame = null;
          terminalHost.refit(spec.key, true);
        });
      }
      if (settle !== null) window.clearTimeout(settle);
      settle = window.setTimeout(() => {
        settle = null;
        terminalHost.refit(spec.key, true);
      }, SETTLE_REFIT_MS);
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onResize);
    observer?.observe(container);
    window.addEventListener('resize', onResize);
    onResize();
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', onResize);
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (settle !== null) window.clearTimeout(settle);
    };
  }, [spec.key]);

  return (
    <div
      ref={containerRef}
      data-terminal-runtime-key={spec.key}
      onMouseDown={() => terminalHost.focus(spec.key)}
      className="aegis-terminal-pane h-full w-full overflow-hidden bg-[var(--bg-primary)] px-2 py-2"
    />
  );
}

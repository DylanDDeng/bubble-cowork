import { useEffect, useMemo, useRef } from 'react';
import type {
  TerminalRuntimeConfig,
  TerminalRuntimeViewState,
} from './terminalRuntimeTypes';
import { terminalRuntimeRegistry } from './terminalRuntimeRegistry';

export function TerminalViewportPane({
  config,
  viewState,
}: {
  config: TerminalRuntimeConfig;
  viewState: TerminalRuntimeViewState;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const memoViewState = useMemo(
    () => ({ isVisible: viewState.isVisible, isActive: viewState.isActive }),
    [viewState.isVisible, viewState.isActive]
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    terminalRuntimeRegistry.attach(config, memoViewState, container);
    return () => {
      terminalRuntimeRegistry.detach(config.runtimeKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.runtimeKey]);

  useEffect(() => {
    terminalRuntimeRegistry.syncConfig(config.runtimeKey, config);
  }, [config]);

  useEffect(() => {
    terminalRuntimeRegistry.setViewState(config.runtimeKey, memoViewState);
  }, [config.runtimeKey, memoViewState]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let frame: number | null = null;
    let settleTimer: number | null = null;
    const requestResize = () => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
      frame = window.requestAnimationFrame(() => {
        frame = null;
        terminalRuntimeRegistry.resize(config.runtimeKey, { clearTextureAtlas: true, refresh: true });
      });

      if (settleTimer !== null) {
        window.clearTimeout(settleTimer);
      }
      settleTimer = window.setTimeout(() => {
        settleTimer = null;
        terminalRuntimeRegistry.resize(config.runtimeKey, { clearTextureAtlas: true, refresh: true });
      }, 220);
    };

    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(requestResize);
    observer?.observe(container);
    window.addEventListener('resize', requestResize);
    requestResize();

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', requestResize);
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
      if (settleTimer !== null) {
        window.clearTimeout(settleTimer);
      }
    };
  }, [config.runtimeKey]);

  return (
    <div
      ref={containerRef}
      data-terminal-runtime-key={config.runtimeKey}
      onMouseDown={() => terminalRuntimeRegistry.focus(config.runtimeKey)}
      onClick={() => terminalRuntimeRegistry.focus(config.runtimeKey)}
      className="aegis-terminal-pane h-full w-full overflow-hidden bg-[var(--bg-primary)] px-2 py-2"
    />
  );
}

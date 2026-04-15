import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { LigaturesAddon } from '@xterm/addon-ligatures';
import { WebglAddon } from '@xterm/addon-webgl';
import type { ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

type TerminalTab = {
  id: string;
  label: string;
};

export function SessionTerminal({
  sessionId,
  cwd,
  onRequestClose,
}: {
  sessionId: string | null;
  cwd: string | null;
  onRequestClose?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const ligaturesAddonRef = useRef<LigaturesAddon | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const tabsRef = useRef<TerminalTab[]>([]);
  const nextTabNumberRef = useRef(1);
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const normalizedCwd = cwd?.trim() || null;
  const normalizedSessionId = sessionId?.trim() || null;
  const canStart = Boolean(normalizedSessionId && normalizedCwd);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) || null,
    [activeTabId, tabs]
  );

  const resolveTerminalFontFamily = (): string => {
    const styles = getComputedStyle(document.documentElement);
    const configured = styles.getPropertyValue('--terminal-font-family').trim();
    return (
      configured ||
      "\"JetBrainsMono NFM\", \"JetBrainsMono NF\", \"JetBrains Mono\", monospace"
    );
  };

  const resolveTerminalTheme = (): ITheme => {
    const styles = getComputedStyle(document.documentElement);
    const bgPrimary = styles.getPropertyValue('--bg-primary').trim() || '#ffffff';
    const bgSecondary = styles.getPropertyValue('--bg-secondary').trim() || '#ffffff';
    const textPrimary = styles.getPropertyValue('--text-primary').trim() || '#111111';
    const textSecondary = styles.getPropertyValue('--text-secondary').trim() || '#62646A';
    const textMuted = styles.getPropertyValue('--text-muted').trim() || '#989BA3';
    const border = styles.getPropertyValue('--border').trim() || '#E5E7EB';
    const accent = styles.getPropertyValue('--accent').trim() || '#111827';
    const success = styles.getPropertyValue('--success').trim() || '#22c55e';
    const warning = styles.getPropertyValue('--warning').trim() || '#f59e0b';
    const error = styles.getPropertyValue('--error').trim() || '#ef4444';

    return {
      background: bgSecondary,
      foreground: textPrimary,
      cursor: accent,
      cursorAccent: bgSecondary,
      selectionBackground: 'rgba(148, 163, 184, 0.18)',
      black: bgPrimary,
      brightBlack: textMuted,
      red: error,
      brightRed: error,
      green: success,
      brightGreen: success,
      yellow: warning,
      brightYellow: warning,
      blue: accent,
      brightBlue: accent,
      magenta: accent,
      brightMagenta: accent,
      cyan: textSecondary,
      brightCyan: textSecondary,
      white: textPrimary,
      brightWhite: textPrimary,
    };
  };

  const syncTerminalSize = (terminalId?: string | null) => {
    if (!terminalRef.current || !fitAddonRef.current) {
      return;
    }

    fitAddonRef.current.fit();
    if (!terminalId) {
      return;
    }

    const { cols, rows } = terminalRef.current;
    void window.electron.resizeTerminalSession(terminalId, cols, rows);
  };

  const stopTerminalTabs = (terminalTabs: TerminalTab[]) => {
    for (const tab of terminalTabs) {
      void window.electron.stopTerminalSession(tab.id);
    }
  };

  const createTab = (terminalNumber: number): TerminalTab => {
    const sessionKey = normalizedSessionId || 'terminal';
    return {
      id: `${sessionKey}:terminal:${Date.now()}:${terminalNumber}`,
      label: `Terminal ${terminalNumber}`,
    };
  };

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    if (!containerRef.current || terminalRef.current) {
      return;
    }

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: resolveTerminalFontFamily(),
      fontSize: 12,
      lineHeight: 1.45,
      customGlyphs: true,
      theme: resolveTerminalTheme(),
      scrollback: 3000,
      convertEol: true,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    fitAddon.fit();
    terminal.focus();

    // Match dpcode's runtime stack, but only after the viewport is mounted and measured.
    const enhancementFrame = window.requestAnimationFrame(() => {
      if (!terminal.element?.isConnected) {
        return;
      }

      try {
        const ligaturesAddon = new LigaturesAddon();
        terminal.loadAddon(ligaturesAddon);
        ligaturesAddonRef.current = ligaturesAddon;
      } catch {
        ligaturesAddonRef.current = null;
      }

      try {
        const webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => {
          webglAddon.dispose();
          if (webglAddonRef.current === webglAddon) {
            webglAddonRef.current = null;
          }
        });
        terminal.loadAddon(webglAddon);
        webglAddonRef.current = webglAddon;
      } catch {
        webglAddonRef.current = null;
      }
    });

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const resize = () => {
      syncTerminalSize(activeTabId);
    };
    window.addEventListener('resize', resize);

    return () => {
      window.removeEventListener('resize', resize);
      window.cancelAnimationFrame(enhancementFrame);
      stopTerminalTabs(tabsRef.current);
      webglAddonRef.current?.dispose();
      webglAddonRef.current = null;
      ligaturesAddonRef.current?.dispose();
      ligaturesAddonRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [activeTabId]);

  useEffect(() => {
    if (!terminalRef.current) {
      return;
    }

    terminalRef.current.options.theme = resolveTerminalTheme();
    terminalRef.current.options.fontFamily = resolveTerminalFontFamily();
  });

  useEffect(() => {
    stopTerminalTabs(tabsRef.current);
    tabsRef.current = [];
    nextTabNumberRef.current = 1;
    setTabs([]);
    setActiveTabId(null);
    setStatus(null);
    terminalRef.current?.clear();

    if (!canStart) {
      return;
    }

    const initialTab = createTab(nextTabNumberRef.current);
    nextTabNumberRef.current += 1;
    tabsRef.current = [initialTab];
    setTabs([initialTab]);
    setActiveTabId(initialTab.id);
  }, [canStart, normalizedCwd, normalizedSessionId]);

  useEffect(() => {
    if (!terminalRef.current || !activeTabId || !normalizedCwd || !canStart) {
      return;
    }

    let cancelled = false;
    setStarting(true);
    setStatus(null);

    const terminal = terminalRef.current;
    terminal.clear();
    terminal.writeln('\x1b[90mStarting terminal...\x1b[0m');
    syncTerminalSize(activeTabId);

    void window.electron.startTerminalSession(
      activeTabId,
      normalizedCwd,
      terminal.cols,
      terminal.rows
    ).then((result) => {
      if (cancelled || !terminalRef.current) {
        return;
      }

      if (!result.ok) {
        const message = result.message || 'Failed to start terminal.';
        setStatus(message);
        terminalRef.current.writeln(`\x1b[31m${message}\x1b[0m`);
        return;
      }

      terminalRef.current.clear();
      if (result.history) {
        terminalRef.current.write(result.history);
      }
      syncTerminalSize(activeTabId);
      terminalRef.current.focus();
    }).catch((error) => {
      if (cancelled || !terminalRef.current) {
        return;
      }

      const message = error instanceof Error ? error.message : 'Failed to start terminal.';
      setStatus(message);
      terminalRef.current.writeln(`\x1b[31m${message}\x1b[0m`);
    }).finally(() => {
      if (!cancelled) {
        setStarting(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [activeTabId, canStart, normalizedCwd]);

  useEffect(() => {
    if (!terminalRef.current || !activeTabId) {
      return;
    }

    const dispose = window.electron.onTerminalEvent((event) => {
      if (!terminalRef.current || event.sessionId !== activeTabId) {
        return;
      }

      if (event.type === 'data' && typeof event.data === 'string') {
        terminalRef.current.write(event.data);
        return;
      }

      if (event.type === 'exit') {
        terminalRef.current.writeln(
          `\r\n\x1b[90m[Process exited${typeof event.exitCode === 'number' ? `: ${event.exitCode}` : ''}]\x1b[0m`
        );
      }
    });

    return dispose;
  }, [activeTabId]);

  useEffect(() => {
    if (!terminalRef.current || !activeTabId) {
      return;
    }

    const terminal = terminalRef.current;
    const disposable = terminal.onData((data) => {
      void window.electron.writeTerminalSession(activeTabId, data);
    });

    return () => {
      disposable.dispose();
    };
  }, [activeTabId]);

  const handleAddTab = () => {
    const nextTab = createTab(nextTabNumberRef.current);
    nextTabNumberRef.current += 1;
    setTabs((current) => [...current, nextTab]);
    setActiveTabId(nextTab.id);
  };

  const handleCloseTab = (tabId: string) => {
    if (tabsRef.current.length <= 1) {
      tabsRef.current = [];
      setTabs([]);
      setActiveTabId(null);
      setStatus(null);
      terminalRef.current?.clear();
      void window.electron.stopTerminalSession(tabId);
      onRequestClose?.();
      return;
    }

    setTabs((current) => {
      const filtered = current.filter((tab) => tab.id !== tabId);
      if (activeTabId === tabId) {
        setActiveTabId(filtered[0]?.id || null);
      }
      void window.electron.stopTerminalSession(tabId);
      return filtered;
    });
  };

  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="flex min-w-0 items-stretch border-b border-[var(--border)]/70 bg-[var(--bg-primary)]">
        <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {tabs.map((tab) => {
            const active = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                className={`group relative flex h-8 shrink-0 items-stretch border-r border-[var(--border)]/70 px-0 text-[12px] transition-colors ${
                  active
                    ? 'bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-[inset_0_1px_0_color-mix(in_srgb,var(--accent)_65%,transparent)]'
                    : 'border-b border-[var(--border)]/70 bg-[var(--bg-secondary)]/35 text-[var(--text-secondary)] hover:bg-[var(--bg-primary)]/70 hover:text-[var(--text-primary)]'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setActiveTabId(tab.id)}
                  className="flex min-w-0 items-center px-2 text-left"
                >
                  <span className="max-w-[160px] truncate text-[11px] leading-4">{tab.label}</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleCloseTab(tab.id)}
                  className="inline-flex w-6 items-center justify-center text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-primary)]/55 hover:text-[var(--text-primary)]"
                  aria-label={`Close ${tab.label}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            onClick={handleAddTab}
            disabled={!canStart}
            className="inline-flex h-8 shrink-0 items-center justify-center border-b border-r border-[var(--border)]/70 px-2 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-primary)]/70 hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="New terminal"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <div className="min-w-0 flex-1 border-b border-[var(--border)]/70" />
        </div>
      </div>

      {!canStart ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-[var(--text-muted)]">
          Select a project folder in the current session to use the terminal.
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden bg-[var(--bg-primary)]">
          <div
            ref={containerRef}
            onMouseDown={() => {
              terminalRef.current?.focus();
              syncTerminalSize(activeTabId);
            }}
            onClick={() => {
              terminalRef.current?.focus();
            }}
            className="h-full w-full overflow-hidden bg-[var(--bg-primary)] px-2 py-2"
          />
        </div>
      )}
    </section>
  );
}

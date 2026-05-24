import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Plus, X } from './icons';
import { Terminal } from '@xterm/xterm';
import { useAgentReadiness, type AgentReadinessEntry } from '../hooks/useAgentReadiness';
import { FitAddon } from '@xterm/addon-fit';
import { LigaturesAddon } from '@xterm/addon-ligatures';
import type { ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

type TerminalAgentKind = 'shell' | 'claude' | 'codex' | 'opencode';

type TerminalAgentSpec = {
  kind: TerminalAgentKind;
  label: string;
  command: string | null;
  provider: 'claude' | 'codex' | 'opencode' | null;
  shortcut: string;
};

const TERMINAL_AGENT_SPECS: TerminalAgentSpec[] = [
  { kind: 'shell', label: 'Default shell', command: null, provider: null, shortcut: '1' },
  { kind: 'claude', label: 'Claude Code', command: 'claude', provider: 'claude', shortcut: '2' },
  { kind: 'codex', label: 'Codex', command: 'codex', provider: 'codex', shortcut: '3' },
  { kind: 'opencode', label: 'OpenCode', command: 'opencode', provider: 'opencode', shortcut: '4' },
];

const LAST_AGENT_STORAGE_KEY = 'aegis.terminal.lastAgent';

function readStoredAgentKind(): TerminalAgentKind {
  if (typeof window === 'undefined') return 'shell';
  try {
    const raw = window.localStorage.getItem(LAST_AGENT_STORAGE_KEY);
    if (raw && TERMINAL_AGENT_SPECS.some((spec) => spec.kind === raw)) {
      return raw as TerminalAgentKind;
    }
  } catch {
    // ignore
  }
  return 'shell';
}

function writeStoredAgentKind(kind: TerminalAgentKind) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LAST_AGENT_STORAGE_KEY, kind);
  } catch {
    // ignore
  }
}

type TerminalTab = {
  id: string;
  label: string;
  agent: TerminalAgentKind;
  pendingCommand: string | null;
};

/**
 * One xterm runtime per tab. Each tab owns its own Terminal instance, FitAddon,
 * Ligatures addon, container <div>, and PTY session. Switching tabs is just a
 * CSS visibility toggle — we never re-init xterm or replay history into a
 * different instance, which is what was corrupting state for TUI apps
 * (Claude Code, Codex, opencode, vim, etc.).
 */
type TabRuntime = {
  terminal: Terminal;
  fitAddon: FitAddon;
  ligaturesAddon: LigaturesAddon | null;
  container: HTMLDivElement;
  ptyStarted: boolean;
  ptyExited: boolean;
  onDataDisposable: { dispose: () => void } | null;
  onTerminalEventDispose: (() => void) | null;
};

function resolveTerminalFontFamily(): string {
  const styles = getComputedStyle(document.documentElement);
  const configured = styles.getPropertyValue('--terminal-font-family').trim();
  return (
    configured ||
    "\"0xProto Nerd Font Mono\", \"0xProto Nerd Font\", \"0xProtoNFM\", \"0xProtoNF\", \"MesloLGS NF\", \"MesloLGS Nerd Font Mono\", \"JetBrainsMono Nerd Font Mono\", \"JetBrainsMono Nerd Font\", \"JetBrainsMono NFM\", \"JetBrainsMono NF\", \"Hack Nerd Font Mono\", \"Symbols Nerd Font Mono\", \"Apple Symbols\", \"Apple Color Emoji\", monospace"
  );
}

function resolveTerminalTheme(): ITheme {
  const styles = getComputedStyle(document.documentElement);
  const bgPrimary = styles.getPropertyValue('--bg-primary').trim() || '#ffffff';
  const bgSecondary = styles.getPropertyValue('--bg-secondary').trim() || '#ffffff';
  const textPrimary = styles.getPropertyValue('--text-primary').trim() || '#111111';
  const textSecondary = styles.getPropertyValue('--text-secondary').trim() || '#62646A';
  const textMuted = styles.getPropertyValue('--text-muted').trim() || '#989BA3';
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
}

export function SessionTerminal({
  sessionId,
  cwd,
  visible = true,
  onRequestClose,
}: {
  sessionId: string | null;
  cwd: string | null;
  visible?: boolean;
  onRequestClose?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const runtimesRef = useRef<Map<string, TabRuntime>>(new Map());
  const tabsRef = useRef<TerminalTab[]>([]);
  const activeTabIdRef = useRef<string | null>(null);
  const visibleRef = useRef(visible);
  const nextTabNumberRef = useRef(1);
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [, setStarting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerAnchor, setPickerAnchor] = useState<{ top: number; left: number } | null>(null);
  const chevronButtonRef = useRef<HTMLButtonElement | null>(null);
  const pickerMenuRef = useRef<HTMLDivElement | null>(null);
  const [lastAgentKind, setLastAgentKind] = useState<TerminalAgentKind>(() => readStoredAgentKind());
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const agentReadiness = useAgentReadiness(null, visible);
  const readinessByProvider = useMemo(() => {
    const map = new Map<string, AgentReadinessEntry>();
    for (const entry of agentReadiness.entries) {
      map.set(entry.provider, entry);
    }
    return map;
  }, [agentReadiness.entries]);
  const readinessRef = useRef(readinessByProvider);
  useEffect(() => {
    readinessRef.current = readinessByProvider;
  }, [readinessByProvider]);

  const normalizedCwd = cwd?.trim() || null;
  const normalizedSessionId = sessionId?.trim() || null;
  const canStart = Boolean(normalizedSessionId && normalizedCwd);

  // ---- helpers ---------------------------------------------------------------

  const fitActive = (tabId: string | null) => {
    if (!tabId) return;
    const runtime = runtimesRef.current.get(tabId);
    if (!runtime) return;
    if (!visibleRef.current) return;
    try {
      runtime.fitAddon.fit();
    } catch {
      return;
    }
    const { cols, rows } = runtime.terminal;
    void window.electron.resizeTerminalSession(tabId, cols, rows);
  };

  const disposeRuntime = (tabId: string) => {
    const runtime = runtimesRef.current.get(tabId);
    if (!runtime) return;
    runtime.onDataDisposable?.dispose();
    runtime.onTerminalEventDispose?.();
    runtime.ligaturesAddon?.dispose();
    runtime.terminal.dispose();
    runtime.container.remove();
    runtimesRef.current.delete(tabId);
    void window.electron.stopTerminalSession(tabId);
  };

  const stopAllTabs = () => {
    for (const id of Array.from(runtimesRef.current.keys())) {
      disposeRuntime(id);
    }
  };

  const createTab = (terminalNumber: number, agentKind: TerminalAgentKind = 'shell'): TerminalTab => {
    const sessionKey = normalizedSessionId || 'terminal';
    const spec = TERMINAL_AGENT_SPECS.find((item) => item.kind === agentKind) ?? TERMINAL_AGENT_SPECS[0];
    const labelPrefix = spec.kind === 'shell' ? 'Terminal' : spec.label;
    return {
      id: `${sessionKey}:terminal:${Date.now()}:${terminalNumber}`,
      label: labelPrefix,
      agent: spec.kind,
      pendingCommand: spec.command,
    };
  };

  const createInitialTab = () => {
    const initialTab = createTab(nextTabNumberRef.current);
    nextTabNumberRef.current += 1;
    tabsRef.current = [initialTab];
    setTabs([initialTab]);
    setActiveTabId(initialTab.id);
  };

  /**
   * Build a Terminal + container for the tab and start its PTY. Idempotent —
   * does nothing if the runtime already exists.
   */
  const ensureRuntime = (tab: TerminalTab) => {
    if (runtimesRef.current.has(tab.id)) return;
    if (!hostRef.current || !normalizedCwd) return;

    // Container — sits inside hostRef. Visibility is toggled via inline style.
    const container = document.createElement('div');
    container.className = 'h-full w-full overflow-hidden bg-[var(--bg-primary)] px-2 py-2';
    container.style.display = tab.id === activeTabIdRef.current ? 'block' : 'none';
    container.dataset.tabId = tab.id;
    hostRef.current.appendChild(container);

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: resolveTerminalFontFamily(),
      fontSize: 12,
      fontWeight: 400,
      fontWeightBold: 700,
      letterSpacing: 0,
      lineHeight: 1.45,
      // NOTE: customGlyphs is intentionally OFF. When enabled, xterm.js draws box-drawing
      // and powerline-style codepoints itself, but its internal range overlaps the Nerd Font
      // PUA region in ways that cause some Nerd Font icons (p10k clock/folder/exit-status,
      // brand glyphs) to render as blank. With it off, xterm goes through Chromium's text
      // pipeline for everything, which uses CoreText fallback through the listed fontFamily.
      customGlyphs: false,
      theme: resolveTerminalTheme(),
      scrollback: 3000,
      convertEol: true,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);

    let ligaturesAddon: LigaturesAddon | null = null;
    // Defer ligatures load until the element is in the document and measurable.
    window.requestAnimationFrame(() => {
      if (!terminal.element?.isConnected) return;
      try {
        ligaturesAddon = new LigaturesAddon();
        terminal.loadAddon(ligaturesAddon);
        const runtime = runtimesRef.current.get(tab.id);
        if (runtime) runtime.ligaturesAddon = ligaturesAddon;
      } catch {
        // ignore
      }
    });

    const runtime: TabRuntime = {
      terminal,
      fitAddon,
      ligaturesAddon: null,
      container,
      ptyStarted: false,
      ptyExited: false,
      onDataDisposable: null,
      onTerminalEventDispose: null,
    };
    runtimesRef.current.set(tab.id, runtime);

    // Wire keystrokes -> PTY (filtering focus reports that some shells request).
    runtime.onDataDisposable = terminal.onData((data) => {
      if (data === '\x1b[I' || data === '\x1b[O') return;
      void window.electron.writeTerminalSession(tab.id, data);
    });

    // Wire PTY -> xterm.
    runtime.onTerminalEventDispose = window.electron.onTerminalEvent((event) => {
      if (event.sessionId !== tab.id) return;
      if (event.type === 'data' && typeof event.data === 'string') {
        terminal.write(event.data);
        return;
      }
      if (event.type === 'exit') {
        runtime.ptyExited = true;
        terminal.writeln(
          `\r\n\x1b[90m[Process exited${typeof event.exitCode === 'number' ? `: ${event.exitCode}` : ''}]\x1b[0m`
        );
      }
    });

    // Initial fit happens before PTY start so we send the correct dimensions.
    try {
      fitAddon.fit();
    } catch {
      // ignore early-fit errors
    }

    if (tab.id === activeTabIdRef.current && visibleRef.current) {
      terminal.focus();
    }

    // Start the PTY session.
    setStarting(true);
    terminal.writeln('\x1b[90mStarting terminal...\x1b[0m');
    void window.electron
      .startTerminalSession(tab.id, normalizedCwd, terminal.cols, terminal.rows)
      .then((result) => {
        const liveRuntime = runtimesRef.current.get(tab.id);
        if (!liveRuntime) return;
        if (!result.ok) {
          const message = result.message || 'Failed to start terminal.';
          setStatus(message);
          liveRuntime.terminal.writeln(`\x1b[31m${message}\x1b[0m`);
          return;
        }
        liveRuntime.ptyStarted = true;
        liveRuntime.terminal.clear();
        // Tell xterm itself to stop reporting focus events on its own input
        // stream. (Writing to the xterm parser, not the PTY — the latter would
        // leak '^[[?1004l' as visible input into the shell prompt.)
        liveRuntime.terminal.write('\x1b[?1004l');
        if (result.history) {
          liveRuntime.terminal.write(result.history);
        }
        try {
          liveRuntime.fitAddon.fit();
        } catch {
          // ignore
        }
        const { cols, rows } = liveRuntime.terminal;
        void window.electron.resizeTerminalSession(tab.id, cols, rows);
        if (tab.id === activeTabIdRef.current && visibleRef.current) {
          liveRuntime.terminal.focus();
        }

        // Inject the agent CLI launch command, if requested.
        const currentTab = tabsRef.current.find((item) => item.id === tab.id);
        if (currentTab && currentTab.pendingCommand) {
          const cmd = currentTab.pendingCommand;
          const provider =
            TERMINAL_AGENT_SPECS.find((spec) => spec.kind === currentTab.agent)?.provider ?? null;
          const readiness = provider ? readinessRef.current.get(provider) : null;
          tabsRef.current = tabsRef.current.map((item) =>
            item.id === tab.id ? { ...item, pendingCommand: null } : item
          );
          setTabs((current) =>
            current.map((item) => (item.id === tab.id ? { ...item, pendingCommand: null } : item))
          );
          if (readiness && readiness.state !== 'ready' && readiness.state !== 'checking') {
            const hint = readiness.command
              ? `\x1b[33m${readiness.summary}. Try: ${readiness.command}\x1b[0m`
              : `\x1b[33m${readiness.summary}\x1b[0m`;
            liveRuntime.terminal.writeln(hint);
          } else {
            window.setTimeout(() => {
              void window.electron.writeTerminalSession(tab.id, `${cmd}\r`);
            }, 80);
          }
        }
      })
      .catch((error) => {
        const liveRuntime = runtimesRef.current.get(tab.id);
        if (!liveRuntime) return;
        const message = error instanceof Error ? error.message : 'Failed to start terminal.';
        setStatus(message);
        liveRuntime.terminal.writeln(`\x1b[31m${message}\x1b[0m`);
      })
      .finally(() => {
        setStarting(false);
      });
  };

  // ---- effects ---------------------------------------------------------------

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  // Theme / font live-update propagation to all open runtimes.
  useEffect(() => {
    const fontFamily = resolveTerminalFontFamily();
    const theme = resolveTerminalTheme();
    for (const runtime of runtimesRef.current.values()) {
      runtime.terminal.options.theme = theme;
      runtime.terminal.options.fontFamily = fontFamily;
    }
  });

  // Reset when session/cwd/canStart changes — kill all PTYs, drop all runtimes.
  useEffect(() => {
    stopAllTabs();
    tabsRef.current = [];
    nextTabNumberRef.current = 1;
    setTabs([]);
    setActiveTabId(null);
    setStatus(null);

    if (!canStart) return;
    createInitialTab();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canStart, normalizedCwd, normalizedSessionId]);

  // If the panel becomes visible later and no tab exists yet, create one.
  useEffect(() => {
    if (!visible || !canStart || tabsRef.current.length > 0) return;
    createInitialTab();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canStart, visible]);

  // Whenever the tab list changes, ensure each tab has a runtime, and clean up
  // runtimes that no longer correspond to a tab.
  useEffect(() => {
    if (!hostRef.current || !canStart) return;
    for (const tab of tabs) {
      ensureRuntime(tab);
    }
    const liveIds = new Set(tabs.map((t) => t.id));
    for (const id of Array.from(runtimesRef.current.keys())) {
      if (!liveIds.has(id)) {
        disposeRuntime(id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, canStart, normalizedCwd]);

  // Toggle visibility of containers when activeTabId changes; focus + resize.
  useEffect(() => {
    for (const [id, runtime] of runtimesRef.current) {
      runtime.container.style.display = id === activeTabId ? 'block' : 'none';
    }
    if (!activeTabId) return;
    const runtime = runtimesRef.current.get(activeTabId);
    if (!runtime) return;
    const frame = window.requestAnimationFrame(() => {
      try {
        runtime.fitAddon.fit();
      } catch {
        // ignore
      }
      const { cols, rows } = runtime.terminal;
      void window.electron.resizeTerminalSession(activeTabId, cols, rows);
      if (visibleRef.current) {
        runtime.terminal.focus();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTabId]);

  // Resize observer + window resize -> fit active terminal.
  useEffect(() => {
    const element = hostRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
        fitActive(activeTabIdRef.current);
      });
    });
    observer.observe(element);

    const onResize = () => fitActive(activeTabIdRef.current);
    window.addEventListener('resize', onResize);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onResize);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, []);

  // When panel becomes visible, refit + refocus.
  useEffect(() => {
    if (!visible) return;
    const frame = window.requestAnimationFrame(() => {
      fitActive(activeTabIdRef.current);
      if (activeTabIdRef.current) {
        runtimesRef.current.get(activeTabIdRef.current)?.terminal.focus();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [visible, activeTabId]);

  // Component unmount: tear everything down.
  useEffect(() => {
    return () => {
      stopAllTabs();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Picker (outside-click + keyboard shortcut).
  useEffect(() => {
    if (!pickerOpen) return;
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (pickerRef.current?.contains(target)) return;
      if (pickerMenuRef.current?.contains(target)) return;
      setPickerOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPickerOpen(false);
        return;
      }
      const spec = TERMINAL_AGENT_SPECS.find((s) => s.shortcut === event.key);
      if (spec) {
        event.preventDefault();
        handleAddTabWithAgent(spec.kind);
      }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickerOpen]);

  const handleAddTab = () => {
    handleAddTabWithAgent(lastAgentKind);
  };

  const handleAddTabWithAgent = (agentKind: TerminalAgentKind) => {
    const nextTab = createTab(nextTabNumberRef.current, agentKind);
    nextTabNumberRef.current += 1;
    setTabs((current) => [...current, nextTab]);
    setActiveTabId(nextTab.id);
    if (lastAgentKind !== agentKind) {
      setLastAgentKind(agentKind);
      writeStoredAgentKind(agentKind);
    }
    setPickerOpen(false);
  };

  const handleCloseTab = (tabId: string) => {
    if (tabsRef.current.length <= 1) {
      // Closing the last tab — tear down and ask parent to hide the panel.
      disposeRuntime(tabId);
      tabsRef.current = [];
      setTabs([]);
      setActiveTabId(null);
      setStatus(null);
      onRequestClose?.();
      return;
    }
    setTabs((current) => {
      const filtered = current.filter((tab) => tab.id !== tabId);
      if (activeTabId === tabId) {
        setActiveTabId(filtered[0]?.id || null);
      }
      // Runtime cleanup happens in the tabs-effect above when it sees the id is gone.
      return filtered;
    });
  };

  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="relative flex min-w-0 items-stretch border-b border-[var(--border)]/70 bg-[var(--bg-primary)]">
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
          <div ref={pickerRef} className="flex shrink-0 items-stretch">
            <button
              type="button"
              onClick={handleAddTab}
              disabled={!canStart}
              className="inline-flex h-8 shrink-0 items-center justify-center border-b border-[var(--border)]/70 px-2 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-primary)]/70 hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
              aria-label={`New ${TERMINAL_AGENT_SPECS.find((spec) => spec.kind === lastAgentKind)?.label ?? 'terminal'}`}
              title={`New ${TERMINAL_AGENT_SPECS.find((spec) => spec.kind === lastAgentKind)?.label ?? 'terminal'}`}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
            <button
              ref={chevronButtonRef}
              type="button"
              onClick={() => {
                setPickerOpen((open) => {
                  const next = !open;
                  if (next && chevronButtonRef.current) {
                    const rect = chevronButtonRef.current.getBoundingClientRect();
                    const MENU_WIDTH = 224;
                    const left = Math.max(8, rect.right - MENU_WIDTH);
                    setPickerAnchor({ top: rect.bottom + 4, left });
                  }
                  return next;
                });
              }}
              disabled={!canStart}
              aria-haspopup="menu"
              aria-expanded={pickerOpen}
              aria-label="Choose terminal type"
              className={`inline-flex h-8 shrink-0 items-center justify-center border-b border-r border-[var(--border)]/70 px-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-primary)]/70 hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50 ${
                pickerOpen ? 'bg-[var(--bg-primary)]/70 text-[var(--text-primary)]' : ''
              }`}
            >
              <ChevronDown className="h-3 w-3" />
            </button>
          </div>
          <div className="min-w-0 flex-1 border-b border-[var(--border)]/70" />
        </div>
        {pickerOpen && pickerAnchor ? (
          <div
            ref={pickerMenuRef}
            role="menu"
            style={{ position: 'fixed', top: pickerAnchor.top, left: pickerAnchor.left }}
            className="z-50 w-56 overflow-hidden rounded-md border border-[var(--border)]/80 bg-[var(--bg-primary)] py-1 shadow-lg"
          >
            {TERMINAL_AGENT_SPECS.map((spec) => {
              const readiness = spec.provider ? readinessByProvider.get(spec.provider) : null;
              const dimmed =
                readiness != null &&
                readiness.state !== 'ready' &&
                readiness.state !== 'checking';
              return (
                <button
                  key={spec.kind}
                  type="button"
                  role="menuitem"
                  onClick={() => handleAddTabWithAgent(spec.kind)}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-secondary)]/60"
                >
                  <span className="inline-flex h-4 w-4 items-center justify-center rounded bg-[var(--bg-secondary)]/60 text-[10px] text-[var(--text-muted)]">
                    {spec.shortcut}
                  </span>
                  <span className={`flex-1 truncate ${dimmed ? 'text-[var(--text-muted)]' : ''}`}>
                    {spec.label}
                  </span>
                  {readiness && readiness.state !== 'ready' && readiness.state !== 'checking' ? (
                    <span
                      className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-amber-400"
                      aria-hidden="true"
                      title={readiness.summary}
                    />
                  ) : null}
                  {spec.kind === lastAgentKind ? (
                    <span className="text-[10px] text-[var(--text-muted)]">default</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      {!canStart ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-[var(--text-muted)]">
          Select a project folder in the current session to use the terminal.
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden bg-[var(--bg-primary)]">
          <div
            ref={hostRef}
            onMouseDown={() => {
              if (activeTabIdRef.current) {
                runtimesRef.current.get(activeTabIdRef.current)?.terminal.focus();
                fitActive(activeTabIdRef.current);
              }
            }}
            onClick={() => {
              if (activeTabIdRef.current) {
                runtimesRef.current.get(activeTabIdRef.current)?.terminal.focus();
              }
            }}
            className="relative h-full w-full overflow-hidden bg-[var(--bg-primary)]"
          />
          {status ? (
            <div className="absolute bottom-2 right-2 rounded bg-[var(--bg-secondary)] px-2 py-1 text-[11px] text-[var(--error)]">
              {status}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

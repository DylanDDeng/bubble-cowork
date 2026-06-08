import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from './icons';
import { useAgentReadiness, type AgentReadinessEntry } from '../hooks/useAgentReadiness';
import type { TerminalActivityState, TerminalAgentKind } from '../../shared/terminal';
import {
  TerminalChrome,
  type TerminalChromeTab,
} from '../terminal/TerminalChrome';
import {
  buildTerminalRuntimeKey,
  terminalRuntimeRegistry,
  type TerminalRuntimeCallbacks,
} from '../terminal/terminalRuntimeRegistry';

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

function activityFromEvent(state: Exclude<TerminalActivityState, 'idle'> | null, hasRunningSubprocess: boolean): TerminalActivityState | null {
  if (state) return state;
  return hasRunningSubprocess ? 'running' : null;
}

type TerminalTab = TerminalChromeTab;

export function SessionTerminal({
  sessionId,
  cwd,
  terminalScopeId,
  visible = true,
  onRequestClose,
}: {
  sessionId: string | null;
  cwd: string | null;
  terminalScopeId?: string | null;
  visible?: boolean;
  onRequestClose?: () => void;
}) {
  const tabsRef = useRef<TerminalTab[]>([]);
  const activeTabIdRef = useRef<string | null>(null);
  const nextTabNumberRef = useRef(1);
  const previousThreadIdRef = useRef<string | null>(null);
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerAnchor, setPickerAnchor] = useState<{ top: number; left: number } | null>(null);
  const chevronButtonRef = useRef<HTMLButtonElement | null>(null);
  const pickerMenuRef = useRef<HTMLDivElement | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const [lastAgentKind, setLastAgentKind] = useState<TerminalAgentKind>(() => readStoredAgentKind());

  const normalizedCwd = cwd?.trim() || null;
  const normalizedSessionId = sessionId?.trim() || null;
  const runtimeThreadId = terminalScopeId?.trim() || normalizedSessionId;
  const canStart = Boolean(runtimeThreadId && normalizedCwd);

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

  const buildLaunch = useCallback((agentKind: TerminalAgentKind): Pick<TerminalTab, 'initialCommand' | 'initialNotice'> => {
    const spec = TERMINAL_AGENT_SPECS.find((item) => item.kind === agentKind) ?? TERMINAL_AGENT_SPECS[0];
    if (!spec.command) {
      return { initialCommand: null, initialNotice: null };
    }
    const readiness = spec.provider ? readinessRef.current.get(spec.provider) : null;
    if (readiness && readiness.state !== 'ready' && readiness.state !== 'checking') {
      return {
        initialCommand: null,
        initialNotice: readiness.command ? `${readiness.summary}. Try: ${readiness.command}` : readiness.summary,
      };
    }
    return { initialCommand: spec.command, initialNotice: null };
  }, []);

  const createTab = useCallback(
    (terminalNumber: number, agentKind: TerminalAgentKind = 'shell'): TerminalTab => {
      const spec = TERMINAL_AGENT_SPECS.find((item) => item.kind === agentKind) ?? TERMINAL_AGENT_SPECS[0];
      const labelPrefix = spec.kind === 'shell' ? 'Terminal' : spec.label;
      const launch = buildLaunch(spec.kind);
      return {
        id: `terminal-${Date.now()}-${terminalNumber}`,
        label: labelPrefix,
        agent: spec.kind,
        activity: null,
        initialCommand: launch.initialCommand,
        initialNotice: launch.initialNotice,
      };
    },
    [buildLaunch]
  );

  const createInitialTab = useCallback(() => {
    const initialTab = createTab(nextTabNumberRef.current);
    nextTabNumberRef.current += 1;
    tabsRef.current = [initialTab];
    setTabs([initialTab]);
    setActiveTabId(initialTab.id);
  }, [createTab]);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  useEffect(() => {
    const previousThreadId = previousThreadIdRef.current;
    if (previousThreadId && previousThreadId !== runtimeThreadId) {
      terminalRuntimeRegistry.disposeThread(previousThreadId);
    }
    previousThreadIdRef.current = runtimeThreadId;

    if (!canStart) {
      if (runtimeThreadId) {
        terminalRuntimeRegistry.disposeThread(runtimeThreadId);
      }
      tabsRef.current = [];
      nextTabNumberRef.current = 1;
      setTabs([]);
      setActiveTabId(null);
      setStatus(null);
      return;
    }

    terminalRuntimeRegistry.disposeThread(runtimeThreadId!);
    tabsRef.current = [];
    nextTabNumberRef.current = 1;
    setTabs([]);
    setActiveTabId(null);
    setStatus(null);
    createInitialTab();

    return () => {
      if (runtimeThreadId) {
        terminalRuntimeRegistry.disposeThread(runtimeThreadId);
      }
    };
  }, [canStart, createInitialTab, normalizedCwd, runtimeThreadId]);

  useEffect(() => {
    if (!visible || !canStart || tabsRef.current.length > 0) return;
    createInitialTab();
  }, [canStart, createInitialTab, visible]);

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
      const spec = TERMINAL_AGENT_SPECS.find((item) => item.shortcut === event.key);
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

  const handleAddTabWithAgent = useCallback(
    (agentKind: TerminalAgentKind) => {
      if (!canStart) return;
      const nextTab = createTab(nextTabNumberRef.current, agentKind);
      nextTabNumberRef.current += 1;
      setTabs((current) => [...current, nextTab]);
      setActiveTabId(nextTab.id);
      if (lastAgentKind !== agentKind) {
        setLastAgentKind(agentKind);
        writeStoredAgentKind(agentKind);
      }
      setPickerOpen(false);
    },
    [canStart, createTab, lastAgentKind]
  );

  const handleAddTab = useCallback(() => {
    handleAddTabWithAgent(lastAgentKind);
  }, [handleAddTabWithAgent, lastAgentKind]);

  const handleCloseTab = useCallback(
    (tabId: string) => {
      if (!runtimeThreadId) return;
      terminalRuntimeRegistry.disposeTerminal(runtimeThreadId, tabId);
      if (tabsRef.current.length <= 1) {
        tabsRef.current = [];
        setTabs([]);
        setActiveTabId(null);
        setStatus(null);
        onRequestClose?.();
        return;
      }
      setTabs((current) => {
        const filtered = current.filter((tab) => tab.id !== tabId);
        if (activeTabIdRef.current === tabId) {
          setActiveTabId(filtered[0]?.id || null);
        }
        return filtered;
      });
    },
    [runtimeThreadId, onRequestClose]
  );

  const updateTabActivity = useCallback((tabId: string, activity: TerminalActivityState | null) => {
    tabsRef.current = tabsRef.current.map((tab) => (tab.id === tabId ? { ...tab, activity } : tab));
    setTabs((current) => current.map((tab) => (tab.id === tabId ? { ...tab, activity } : tab)));
  }, []);

  const callbacksForTab = useCallback(
    (tab: TerminalTab): TerminalRuntimeCallbacks => ({
      onActivity: (event) => {
        updateTabActivity(tab.id, activityFromEvent(event.agentState, event.hasRunningSubprocess));
      },
      onExit: () => {
        updateTabActivity(tab.id, null);
      },
      onError: (message) => {
        setStatus(message);
      },
    }),
    [updateTabActivity]
  );

  const picker = canStart ? (
    <div ref={pickerRef} className="flex shrink-0 items-stretch">
      <button
        ref={chevronButtonRef}
        type="button"
        onClick={() => {
          setPickerOpen((open) => {
            const next = !open;
            if (next && chevronButtonRef.current) {
              const rect = chevronButtonRef.current.getBoundingClientRect();
              const menuWidth = 224;
              const left = Math.max(8, rect.right - menuWidth);
              setPickerAnchor({ top: rect.bottom + 4, left });
            }
            return next;
          });
        }}
        aria-haspopup="menu"
        aria-expanded={pickerOpen}
        aria-label="Choose terminal type"
        className={`inline-flex h-8 shrink-0 items-center justify-center border-b border-r border-[var(--border)]/70 px-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-primary)]/70 hover:text-[var(--text-primary)] ${
          pickerOpen ? 'bg-[var(--bg-primary)]/70 text-[var(--text-primary)]' : ''
        }`}
      >
        <ChevronDown className="h-3 w-3" />
      </button>
    </div>
  ) : null;

  return (
    <>
      {!canStart || !runtimeThreadId || !normalizedCwd ? (
        <section className="flex h-full min-h-0 flex-col">
          <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-[var(--text-muted)]">
            Select a project folder in the current session to use the terminal.
          </div>
        </section>
      ) : (
        <div className="relative h-full min-h-0">
          <TerminalChrome
            threadId={runtimeThreadId}
            cwd={normalizedCwd}
            visible={visible}
            tabs={tabs}
            activeTabId={activeTabId}
            onActiveTabChange={setActiveTabId}
            onCloseTab={handleCloseTab}
            onAddTab={handleAddTab}
            picker={picker}
            callbacksForTab={callbacksForTab}
          />
          {status ? (
            <div className="absolute bottom-2 right-2 z-10 rounded bg-[var(--bg-secondary)] px-2 py-1 text-[11px] text-[var(--error)]">
              {status}
            </div>
          ) : null}
        </div>
      )}
      {pickerOpen && pickerAnchor
        ? createPortal(
            <div
              ref={pickerMenuRef}
              role="menu"
              style={{ position: 'fixed', top: pickerAnchor.top, left: pickerAnchor.left }}
              className="z-[200] w-56 overflow-hidden rounded-md border border-[var(--border)]/80 bg-[var(--bg-primary)] py-1 shadow-lg"
            >
              {TERMINAL_AGENT_SPECS.map((spec) => {
                const readiness = spec.provider ? readinessByProvider.get(spec.provider) : null;
                const dimmed =
                  readiness != null && readiness.state !== 'ready' && readiness.state !== 'checking';
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
            </div>,
            document.body
          )
        : null}
    </>
  );
}

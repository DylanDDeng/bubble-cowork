import { useMemo, useState } from 'react';
import { TerminalActivityIndicator } from './TerminalActivityIndicator';
import { TerminalIdentityIcon } from './TerminalIdentityIcon';
import { TerminalViewportPane } from './TerminalViewportPane';
import { buildTerminalRuntimeKey, terminalRuntimeRegistry } from './terminalRuntimeRegistry';
import type { TerminalRuntimeCallbacks, TerminalRuntimeConfig } from './terminalRuntimeTypes';
import type { TerminalActivityState, TerminalAgentKind } from '../../shared/terminal';
import { Copy, Plus, Search, Trash2, X } from '../components/icons';

export type TerminalChromeTab = {
  id: string;
  label: string;
  agent: TerminalAgentKind;
  activity: TerminalActivityState | null;
  initialCommand: string | null;
  initialNotice: string | null;
};

export function TerminalChrome({
  threadId,
  cwd,
  visible,
  tabs,
  activeTabId,
  onActiveTabChange,
  onCloseTab,
  onAddTab,
  picker,
  callbacksForTab,
}: {
  threadId: string;
  cwd: string;
  visible: boolean;
  tabs: TerminalChromeTab[];
  activeTabId: string | null;
  onActiveTabChange: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onAddTab: () => void;
  picker?: React.ReactNode;
  callbacksForTab: (tab: TerminalChromeTab) => TerminalRuntimeCallbacks;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const activeRuntimeKey = activeTabId ? buildTerminalRuntimeKey(threadId, activeTabId) : null;

  const configs = useMemo(() => {
    const map = new Map<string, TerminalRuntimeConfig>();
    for (const tab of tabs) {
      map.set(tab.id, {
        runtimeKey: buildTerminalRuntimeKey(threadId, tab.id),
        threadId,
        terminalId: tab.id,
        cwd,
        agentKind: tab.agent,
        initialCommand: tab.initialCommand,
        initialNotice: tab.initialNotice,
        callbacks: callbacksForTab(tab),
      });
    }
    return map;
  }, [callbacksForTab, cwd, tabs, threadId]);

  const handleSearch = (query: string) => {
    setSearchQuery(query);
    if (!activeRuntimeKey || !query) return;
    terminalRuntimeRegistry.search(activeRuntimeKey, query);
  };

  const handleCopy = async () => {
    if (!activeRuntimeKey) return;
    terminalRuntimeRegistry.focus(activeRuntimeKey);
    try {
      await navigator.clipboard.writeText(window.getSelection()?.toString().trimEnd() || '');
    } catch {
      // ignore clipboard permission failures
    }
  };

  const handleClear = () => {
    if (!activeRuntimeKey) return;
    terminalRuntimeRegistry.clear(activeRuntimeKey);
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
                  onClick={() => onActiveTabChange(tab.id)}
                  className="flex min-w-0 items-center gap-1.5 px-2 text-left"
                >
                  <TerminalIdentityIcon agentKind={tab.agent} />
                  <TerminalActivityIndicator activity={tab.activity} />
                  <span className="max-w-[160px] truncate text-[11px] leading-4">{tab.label}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onCloseTab(tab.id)}
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
            onClick={onAddTab}
            className="inline-flex h-8 shrink-0 items-center justify-center border-b border-[var(--border)]/70 px-2 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-primary)]/70 hover:text-[var(--text-primary)]"
            aria-label="New terminal"
            title="New terminal"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          {picker}
          <div className="min-w-0 flex-1 border-b border-[var(--border)]/70" />
        </div>
        <div className="flex h-8 shrink-0 items-center border-b border-[var(--border)]/70">
          {searchOpen ? (
            <input
              value={searchQuery}
              onChange={(event) => handleSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setSearchOpen(false);
                  setSearchQuery('');
                }
                if (event.key === 'Enter' && activeRuntimeKey && searchQuery) {
                  terminalRuntimeRegistry.search(activeRuntimeKey, searchQuery);
                }
              }}
              autoFocus
              className="h-6 w-44 border-l border-[var(--border)]/70 bg-transparent px-2 text-[11px] outline-none placeholder:text-[var(--text-muted)]"
              placeholder="Search"
            />
          ) : null}
          <button
            type="button"
            onClick={() => setSearchOpen((open) => !open)}
            className="inline-flex h-8 w-8 items-center justify-center text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-secondary)]/50 hover:text-[var(--text-primary)]"
            aria-label="Search terminal"
            title="Search terminal"
          >
            <Search className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex h-8 w-8 items-center justify-center text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-secondary)]/50 hover:text-[var(--text-primary)]"
            aria-label="Copy selection"
            title="Copy selection"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={handleClear}
            className="inline-flex h-8 w-8 items-center justify-center text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-secondary)]/50 hover:text-[var(--text-primary)]"
            aria-label="Clear terminal"
            title="Clear terminal"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-[var(--bg-primary)]">
        {tabs.map((tab) => {
          const config = configs.get(tab.id);
          if (!config) return null;
          const active = tab.id === activeTabId;
          return (
            <div key={tab.id} className={`${active ? 'block' : 'hidden'} h-full w-full`}>
              <TerminalViewportPane config={config} viewState={{ isVisible: visible, isActive: active }} />
            </div>
          );
        })}
      </div>
    </section>
  );
}

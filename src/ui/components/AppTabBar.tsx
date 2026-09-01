import { useEffect } from 'react';
import { Clock, Columns2, GitPullRequest, MessageSquare, Plus, Script, X } from './icons';
import { AgentIcon } from './ComposerAgentControls';
import { SidebarHeaderTrigger } from './Sidebar';
import { SessionHistoryButtons } from './SessionHistoryButtons';
import { StageIcon } from './board-support';
import { useAppStore } from '../store/useAppStore';
import { useBoardStore } from '../store/useBoardStore';
import { useTabsStore, type AppTab } from '../store/useTabsStore';
import type { ReactNode } from 'react';

/**
 * Browser-style tab strip across the top of the main content column. The bar
 * itself is the window drag region; every interactive child opts out.
 */
export function AppTabBar() {
  const tabs = useTabsStore((state) => state.tabs);
  const activeTabId = useTabsStore((state) => state.activeTabId);
  const activateTab = useTabsStore((state) => state.activateTab);
  const closeTab = useTabsStore((state) => state.closeTab);
  const openTab = useTabsStore((state) => state.openTab);
  const sidebarCollapsed = useAppStore((state) => state.sidebarCollapsed);

  // Browser keys: ⌘T new tab, ⌘W close, ⌘1–9 jump, ⌃(⇧)Tab cycle.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      const { tabs, activeTabId, activateTab, closeTab, openTab } = useTabsStore.getState();
      if (mod && !event.shiftKey && event.key === 't') {
        event.preventDefault();
        openTab({ kind: 'chat', sessionId: null });
        return;
      }
      if (mod && !event.shiftKey && event.key === 'w') {
        if (tabs.length > 1 && activeTabId) {
          event.preventDefault();
          closeTab(activeTabId);
        }
        return;
      }
      if (mod && !event.shiftKey && /^[1-9]$/.test(event.key)) {
        const index = Number(event.key) - 1;
        const tab = event.key === '9' ? tabs[tabs.length - 1] : tabs[index];
        if (tab) {
          event.preventDefault();
          activateTab(tab.id);
        }
        return;
      }
      if (event.ctrlKey && !event.metaKey && event.key === 'Tab') {
        if (tabs.length > 1 && activeTabId) {
          event.preventDefault();
          const index = tabs.findIndex((tab) => tab.id === activeTabId);
          const nextIndex = event.shiftKey
            ? (index - 1 + tabs.length) % tabs.length
            : (index + 1) % tabs.length;
          activateTab(tabs[nextIndex].id);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div
      className={`drag-region flex flex-shrink-0 items-center gap-1 pr-2 ${
        sidebarCollapsed ? 'h-11 pl-[76px]' : 'h-9 pl-2'
      }`}
    >
      {sidebarCollapsed ? (
        <div className="no-drag mr-1 flex items-center">
          <SidebarHeaderTrigger />
          <SessionHistoryButtons />
        </div>
      ) : null}
      <div className="no-drag flex min-w-0 items-center gap-1 overflow-x-auto">
        {tabs.map((tab) => (
          <TabItem
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            closable={tabs.length > 1}
            onActivate={() => activateTab(tab.id)}
            onClose={() => closeTab(tab.id)}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={() => openTab({ kind: 'chat', sessionId: null })}
        title="New tab (⌘T)"
        aria-label="New tab"
        className="no-drag inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function TabItem({
  tab,
  active,
  closable,
  onActivate,
  onClose,
}: {
  tab: AppTab;
  active: boolean;
  closable: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  const { icon, title } = useTabDescriptor(tab);
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      onMouseDown={(event) => {
        // Pointer activation should not paint the keyboard focus ring while
        // the view behind the tab is switching. Keyboard navigation can still
        // focus the tab normally through tabIndex.
        event.preventDefault();
      }}
      onClick={onActivate}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onActivate();
      }}
      onAuxClick={(event) => {
        // Middle click closes, like a browser.
        if (event.button === 1 && closable) onClose();
      }}
      className={`group flex h-7 min-w-0 max-w-[200px] flex-shrink-0 cursor-default items-center gap-1.5 rounded-lg px-2.5 text-[12px] outline-none transition-colors focus-visible:bg-[var(--sidebar-item-hover)] ${
        active
          ? 'border border-[var(--border)] bg-[var(--bg-primary)] font-medium text-[var(--text-primary)] shadow-[0_1px_2px_rgba(15,18,25,0.04)]'
          : 'border border-transparent text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]'
      }`}
    >
      <span className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 truncate">{title}</span>
      {closable ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          title="Close tab (⌘W)"
          aria-label={`Close ${title}`}
          className={`-mr-1 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-[var(--text-muted)] transition-opacity hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] ${
            active ? 'opacity-60 hover:opacity-100' : 'opacity-0 group-hover:opacity-60 hover:!opacity-100'
          }`}
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </div>
  );
}

function useTabDescriptor(tab: AppTab): { icon: ReactNode; title: string } {
  const view = tab.view;
  const session = useAppStore((state) =>
    view.kind === 'chat' && view.sessionId ? state.sessions[view.sessionId] : undefined
  );
  const task = useBoardStore((state) =>
    view.kind === 'board' && view.taskId ? state.tasks[view.taskId] : undefined
  );

  if (view.kind === 'board') {
    if (view.taskId) {
      return {
        icon: task ? <StageIcon stage={task.stage} className="h-3.5 w-3.5" /> : <Columns2 className="h-3.5 w-3.5" />,
        title: task?.title || 'Task',
      };
    }
    return { icon: <Columns2 className="h-3.5 w-3.5" />, title: 'Board' };
  }
  if (view.kind === 'chat') {
    if (view.sessionId) {
      return {
        icon: session?.provider ? (
          <AgentIcon provider={session.provider} />
        ) : (
          <MessageSquare className="h-3.5 w-3.5" />
        ),
        title: session?.title?.trim() || 'Chat',
      };
    }
    return { icon: <MessageSquare className="h-3.5 w-3.5" />, title: 'New Chat' };
  }
  if (view.kind === 'automations') {
    return { icon: <Clock className="h-3.5 w-3.5" />, title: 'Automations' };
  }
  if (view.kind === 'prs') {
    return { icon: <GitPullRequest className="h-3.5 w-3.5" />, title: 'Pull Requests' };
  }
  return { icon: <Script className="h-3.5 w-3.5" />, title: 'Skill Library' };
}

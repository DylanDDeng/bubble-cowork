import { ArrowLeft, ArrowRight } from './icons';
import { useAppStore } from '../store/useAppStore';
import { useBoardStore } from '../store/useBoardStore';
import { canNavigateActiveTab, isTabViewVisitable, useTabsStore, type TabView } from '../store/useTabsStore';

function shortcutMod(): string {
  if (typeof navigator === 'undefined') return 'Ctrl+';
  return /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
}

/**
 * Back/Forward through the active tab's view history: sessions, the board,
 * a board task's detail page, and the other workspaces alike.
 */
export function SessionHistoryButtons({ className = '' }: { className?: string }) {
  const sessions = useAppStore((state) => state.sessions);
  const boardTasks = useBoardStore((state) => state.tasks);
  const tabs = useTabsStore((state) => state.tabs);
  const activeTabId = useTabsStore((state) => state.activeTabId);
  const goBack = useTabsStore((state) => state.goBack);
  const goForward = useTabsStore((state) => state.goForward);

  const visitable = (view: TabView) => isTabViewVisitable(view, sessions, boardTasks);
  const canBack = canNavigateActiveTab({ tabs, activeTabId }, -1, visitable);
  const canForward = canNavigateActiveTab({ tabs, activeTabId }, 1, visitable);
  const mod = shortcutMod();

  return (
    <div className={`no-drag flex shrink-0 items-center ${className}`.trim()}>
      <button
        type="button"
        disabled={!canBack}
        onClick={() => goBack()}
        className={navButtonClass(canBack)}
        title={`Back (${mod}[)`}
        aria-label="Back"
      >
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.25} />
      </button>
      <button
        type="button"
        disabled={!canForward}
        onClick={() => goForward()}
        className={navButtonClass(canForward)}
        title={`Forward (${mod}])`}
        aria-label="Forward"
      >
        <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.25} />
      </button>
    </div>
  );
}

function navButtonClass(enabled: boolean): string {
  return `inline-flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${
    enabled
      ? 'text-[var(--text-muted)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-secondary)]'
      : 'cursor-default text-[var(--text-muted)] opacity-40'
  }`;
}

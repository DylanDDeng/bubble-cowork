import { ArrowLeft, ArrowRight } from './icons';
import { useAppStore } from '../store/useAppStore';
import { canMoveSessionHistory } from '../utils/session-history';

function shortcutMod(): string {
  if (typeof navigator === 'undefined') return 'Ctrl+';
  return /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
}

function sessionHistoryVisitable(
  sessions: Record<string, { id: string }>,
  entry: string | null
): boolean {
  return entry === null || Boolean(sessions[entry]);
}

export function SessionHistoryButtons({ className = '' }: { className?: string }) {
  const sessions = useAppStore((state) => state.sessions);
  const stack = useAppStore((state) => state.sessionHistoryStack);
  const index = useAppStore((state) => state.sessionHistoryIndex);
  const goBack = useAppStore((state) => state.goSessionHistoryBack);
  const goForward = useAppStore((state) => state.goSessionHistoryForward);

  const visitable = (entry: string | null) => sessionHistoryVisitable(sessions, entry);
  const canBack = canMoveSessionHistory(stack, index, -1, visitable);
  const canForward = canMoveSessionHistory(stack, index, 1, visitable);
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

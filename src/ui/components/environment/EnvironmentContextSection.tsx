import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Bookmark, Pin, RefreshCw } from '../icons';
import { sendEvent } from '../../hooks/useIPC';
import type { SessionEnvironmentContext } from '../../../shared/types';
import type { ActiveEnvironmentContext } from './useActiveEnvironmentContext';

function formatRecapUpdatedAt(value: number | null): string {
  if (!value) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (seconds < 5) return 'Updated just now';
  if (seconds < 60) return `Updated ${seconds}s ago`;
  return `Updated ${Math.floor(seconds / 60)}m ago`;
}

export function EnvironmentContextSection({ context }: { context: ActiveEnvironmentContext }) {
  const [environmentContext, setEnvironmentContext] = useState<SessionEnvironmentContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [recapRefreshing, setRecapRefreshing] = useState(false);
  const sessionId = context.sessionId;

  useEffect(() => {
    setEnvironmentContext(null);
    if (!sessionId || context.unavailableReason) return;

    let cancelled = false;
    setLoading(true);
    void window.electron.getSessionEnvironmentContext(sessionId)
      .then((result) => {
        if (cancelled) return;
        if (!result.ok || !result.context) {
          toast.error(result.message || 'Failed to load environment context.');
          return;
        }
        setEnvironmentContext(result.context);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [context.unavailableReason, sessionId]);

  useEffect(() => {
    if (!sessionId || !window.electron?.onServerEvent) return;

    const unsubscribe = window.electron.onServerEvent((event) => {
      if (event.type !== 'session.environmentRecap' || event.payload.sessionId !== sessionId) {
        return;
      }
      setEnvironmentContext((current) =>
        current
          ? {
              ...current,
              recap: event.payload.recap,
            }
          : current
      );
      setRecapRefreshing(false);
    });

    return unsubscribe;
  }, [sessionId]);

  const refreshRecap = async () => {
    if (!sessionId) return;
    setRecapRefreshing(true);
    try {
      const result = await window.electron.refreshSessionEnvironmentRecap(sessionId);
      if (!result.ok || !result.recap) {
        toast.error(result.message || 'Failed to refresh recap.');
        return;
      }
      const recap = result.recap;
      setEnvironmentContext((current) =>
        current
          ? {
              ...current,
              recap,
            }
          : current
      );
    } finally {
      setRecapRefreshing(false);
    }
  };

  if (!sessionId || context.unavailableReason) {
    return null;
  }

  const recapSummary = environmentContext?.recap.summary;
  const recapUpdatedAt = environmentContext?.recap.updatedAt ?? null;

  return (
    <section className="space-y-2 border-t border-[var(--border)] px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--text-primary)]">
          <Bookmark className="h-3.5 w-3.5 text-[var(--text-muted)]" />
          <span>Context</span>
        </div>
        <button
          type="button"
          onClick={() => sendEvent({ type: 'session.togglePin', payload: { sessionId } })}
          className={`inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11px] transition-colors ${
            context.session?.pinned
              ? 'bg-[var(--sidebar-item-active)] text-[var(--text-primary)]'
              : 'text-[var(--text-muted)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]'
          }`}
        >
          <Pin className="h-3 w-3" />
          <span>{context.session?.pinned ? 'Pinned' : 'Pin'}</span>
        </button>
      </div>
      <div className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-2">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">Recap</span>
          <button
            type="button"
            onClick={() => void refreshRecap()}
            disabled={loading || recapRefreshing}
            className="inline-flex h-5 items-center gap-1 rounded px-1.5 text-[10px] text-[var(--text-muted)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${recapRefreshing ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
        </div>
        <div className="max-h-56 overflow-y-auto whitespace-pre-wrap text-[11px] leading-4 text-[var(--text-muted)]">
          {loading
            ? 'Loading recap...'
            : recapRefreshing
              ? 'Generating summary...'
              : recapSummary || 'No recap yet.'}
        </div>
        {recapUpdatedAt ? (
          <div className="mt-1.5 text-[10px] text-[var(--text-muted)]">
            {formatRecapUpdatedAt(recapUpdatedAt)}
          </div>
        ) : null}
      </div>
    </section>
  );
}

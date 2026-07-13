import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { Brain, ChevronRight, RefreshCw } from '../icons';
import { MDContent } from '../../render/markdown';
import type { SessionEnvironmentContext } from '../../../shared/types';
import type { ActiveEnvironmentContext } from './useActiveEnvironmentContext';

const CARD_WIDTH = 360;
const CARD_GAP = 10;
const VIEWPORT_MARGIN = 12;
const CLOSE_DELAY_MS = 160;

function formatRecapAge(value: number | null): string {
  if (!value) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

export function EnvironmentContextSection({ context }: { context: ActiveEnvironmentContext }) {
  const [environmentContext, setEnvironmentContext] = useState<SessionEnvironmentContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [recapRefreshing, setRecapRefreshing] = useState(false);
  const [cardOpen, setCardOpen] = useState(false);
  const [cardTop, setCardTop] = useState<number | null>(null);
  const rowRef = useRef<HTMLButtonElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const sessionId = context.sessionId;

  useEffect(() => {
    setEnvironmentContext(null);
    setCardOpen(false);
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
        if (result.context.recap.summary.trim()) return;
        // Backfill a missing recap when the card is actually opened; failures
        // (e.g. a session too short to summarize) stay silent here.
        setRecapRefreshing(true);
        void window.electron.refreshSessionEnvironmentRecap(sessionId)
          .then((refreshed) => {
            if (cancelled || !refreshed.ok || !refreshed.recap) return;
            const recap = refreshed.recap;
            setEnvironmentContext((current) => (current ? { ...current, recap } : current));
          })
          .finally(() => {
            if (!cancelled) setRecapRefreshing(false);
          });
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

  // Align the card with the row, then clamp it inside the viewport once its
  // real height is known (the recap length varies wildly between sessions).
  useLayoutEffect(() => {
    if (!cardOpen) return;
    const rowRect = rowRef.current?.getBoundingClientRect();
    const cardHeight = cardRef.current?.getBoundingClientRect().height ?? 0;
    if (!rowRect) return;
    const preferred = rowRect.top - 8;
    const maxTop = window.innerHeight - cardHeight - VIEWPORT_MARGIN;
    setCardTop(Math.max(VIEWPORT_MARGIN, Math.min(preferred, maxTop)));
  }, [cardOpen, environmentContext, loading, recapRefreshing]);

  useEffect(() => {
    if (!cardOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCardOpen(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [cardOpen]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    };
  }, []);

  const cancelScheduledClose = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const openCard = () => {
    cancelScheduledClose();
    setCardOpen(true);
  };

  const scheduleClose = () => {
    cancelScheduledClose();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setCardOpen(false);
    }, CLOSE_DELAY_MS);
  };

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

  const recapSummary = environmentContext?.recap.summary?.trim() || '';
  const recapUpdatedAt = environmentContext?.recap.updatedAt ?? null;
  const rowDetail = loading
    ? 'Loading...'
    : recapRefreshing
      ? 'Generating...'
      : formatRecapAge(recapUpdatedAt);

  const rowRect = rowRef.current?.getBoundingClientRect();
  const cardRight = rowRect ? window.innerWidth - rowRect.left + CARD_GAP : null;

  return (
    <section className="space-y-1 border-t border-[var(--border)] px-3 py-3">
      <div className="px-2 pb-1 text-[11px] font-medium text-[var(--text-muted)]">Context</div>
      <button
        ref={rowRef}
        type="button"
        onClick={openCard}
        onMouseEnter={openCard}
        onMouseLeave={scheduleClose}
        onFocus={openCard}
        onBlur={(event) => {
          // Keep the card open when focus moves into it (e.g. the Refresh button).
          if (cardRef.current?.contains(event.relatedTarget as Node | null)) return;
          scheduleClose();
        }}
        className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--sidebar-item-hover)]"
      >
        <Brain className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
        <span className="min-w-0 flex-1 truncate">Recap</span>
        {rowDetail ? (
          <span className="max-w-[120px] truncate text-[11px] text-[var(--text-muted)]">{rowDetail}</span>
        ) : null}
        <ChevronRight className="h-3 w-3 shrink-0 text-[var(--text-muted)]" />
      </button>
      {cardOpen && cardRight !== null
        ? createPortal(
            <div
              ref={cardRef}
              data-environment-hub-layer
              onMouseEnter={cancelScheduledClose}
              onMouseLeave={scheduleClose}
              className="no-drag fixed z-[80] flex max-h-[min(480px,calc(100vh-24px))] flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_20px_50px_rgba(15,23,42,0.18)]"
              style={{
                width: CARD_WIDTH,
                right: cardRight,
                top: cardTop ?? VIEWPORT_MARGIN,
                visibility: cardTop === null ? 'hidden' : undefined,
              }}
            >
              <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-3">
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="text-[13px] font-semibold text-[var(--text-primary)]">Recap</span>
                  {recapUpdatedAt ? (
                    <span className="truncate text-[11px] text-[var(--text-muted)]">
                      Updated {formatRecapAge(recapUpdatedAt)}
                    </span>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => void refreshRecap()}
                  disabled={loading || recapRefreshing}
                  title="Refresh recap"
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] disabled:opacity-50"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${recapRefreshing ? 'animate-spin' : ''}`} />
                </button>
              </div>
              <div className="scrollbar-slim min-h-0 overflow-y-auto px-4 pb-3">
                {loading ? (
                  <div className="py-1 text-[12px] text-[var(--text-muted)]">Loading recap...</div>
                ) : recapRefreshing && !recapSummary ? (
                  <div className="py-1 text-[12px] text-[var(--text-muted)]">Generating summary...</div>
                ) : recapSummary ? (
                  <MDContent content={recapSummary} className="environment-recap-markdown" />
                ) : (
                  <div className="py-1 text-[12px] text-[var(--text-muted)]">No recap yet.</div>
                )}
              </div>
            </div>,
            document.body
          )
        : null}
    </section>
  );
}

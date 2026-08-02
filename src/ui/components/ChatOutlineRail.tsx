import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Paperclip } from './icons';
import { FileTypeIcon } from './FileTypeIcon';
import type { SessionUserPromptSummary } from '../types';

const MAX_CARD_CHIPS = 3;

/**
 * Footer chips: files the turn changed (with file-type icons); when the turn
 * touched nothing, fall back to the prompt's attachments.
 */
function OutlineCardChips({ item }: { item: SessionUserPromptSummary }) {
  const files = item.changedFiles;
  const names = files.length > 0 ? files : item.attachmentNames;
  if (names.length === 0) {
    return null;
  }
  const hasBodyAbove = Boolean(item.text || item.replyText);

  return (
    <div className={`flex items-center gap-2.5 overflow-hidden ${hasBodyAbove ? 'mt-2.5' : ''}`}>
      {names.slice(0, MAX_CARD_CHIPS).map((name, index) => (
        <span
          key={`${name}-${index}`}
          className="inline-flex min-w-0 flex-shrink items-center gap-1 text-[11.5px] text-[var(--text-secondary)]"
        >
          {files.length > 0 ? (
            <FileTypeIcon name={name} className="h-3.5 w-3.5 flex-shrink-0" />
          ) : (
            <Paperclip className="h-3 w-3 flex-shrink-0" />
          )}
          <span className="truncate">{name}</span>
        </span>
      ))}
      {names.length > MAX_CARD_CHIPS ? (
        <span className="flex-shrink-0 text-[11.5px] text-[var(--text-muted)]">
          +{names.length - MAX_CARD_CHIPS}
        </span>
      ) : null}
    </div>
  );
}

const TICK_PITCH_PX = 8;
const RAIL_MAX_HEIGHT_PX = 340;
const MIN_TICKS = 2;
const TICK_BASE_WIDTH_PX = 8;
const TICK_MAX_WIDTH_PX = 14;
const TICK_INFLUENCE_RADIUS = 3;

/**
 * Smoothly widens the tick under the pointer and its two nearest neighbours.
 * A quadratic falloff keeps the centre prominent while letting the emphasis
 * blend continuously between ticks as the pointer moves.
 */
function getTickScale(index: number, hoverPosition: number | null): number {
  if (hoverPosition === null) {
    return 1;
  }

  const distance = Math.abs(index - hoverPosition);
  const proximity = Math.max(0, 1 - distance / TICK_INFLUENCE_RADIUS);
  const width =
    TICK_BASE_WIDTH_PX +
    (TICK_MAX_WIDTH_PX - TICK_BASE_WIDTH_PX) * proximity * proximity;
  return width / TICK_BASE_WIDTH_PX;
}

/**
 * Vertical outline of the session's user prompts, floated over the left edge
 * of the chat scroll area (Codex-style). One tick per prompt across the WHOLE
 * session history (fetched via a lightweight index IPC, merged with the
 * loaded messages so brand-new prompts appear without a refetch). Hovering a
 * tick shows a preview card; clicking navigates via the existing
 * history-navigation machinery, which auto-loads older pages as needed.
 */
export function ChatOutlineRail({
  sessionId,
  livePrompts,
  onNavigate,
}: {
  sessionId: string;
  livePrompts: SessionUserPromptSummary[];
  onNavigate: (createdAt: number) => void;
}) {
  const [fetched, setFetched] = useState<SessionUserPromptSummary[]>([]);
  const [fetchedSessionId, setFetchedSessionId] = useState<string | null>(null);
  const [hoverPosition, setHoverPosition] = useState<number | null>(null);
  const hoverFrameRef = useRef(0);
  const pendingHoverPositionRef = useRef<number | null>(null);

  const scheduleHoverPosition = useCallback((nextPosition: number) => {
    pendingHoverPositionRef.current = nextPosition;
    if (hoverFrameRef.current) {
      return;
    }
    hoverFrameRef.current = requestAnimationFrame(() => {
      hoverFrameRef.current = 0;
      setHoverPosition(pendingHoverPositionRef.current);
    });
  }, []);

  const clearHoverPosition = useCallback(() => {
    pendingHoverPositionRef.current = null;
    if (hoverFrameRef.current) {
      cancelAnimationFrame(hoverFrameRef.current);
      hoverFrameRef.current = 0;
    }
    setHoverPosition(null);
  }, []);

  useEffect(
    () => () => {
      if (hoverFrameRef.current) {
        cancelAnimationFrame(hoverFrameRef.current);
      }
    },
    []
  );

  // Refetch on session switch and when the loaded prompt count changes (new
  // prompt sent, rewind) so the index never drifts far from the DB.
  const livePromptCount = livePrompts.length;
  useEffect(() => {
    let cancelled = false;

    window.electron
      .getSessionUserPrompts(sessionId)
      .then((summaries) => {
        if (cancelled) return;
        setFetched(summaries);
        setFetchedSessionId(sessionId);
      })
      .catch(() => {
        // Sessions without a backing store (drafts, just-imported) simply
        // fall back to the loaded messages.
        if (cancelled) return;
        setFetched([]);
        setFetchedSessionId(sessionId);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, livePromptCount]);

  const items = useMemo(() => {
    const byCreatedAt = new Map<number, SessionUserPromptSummary>();
    // Ignore a stale fetch from the previously viewed session.
    if (fetchedSessionId === sessionId) {
      for (const summary of fetched) {
        byCreatedAt.set(summary.createdAt, summary);
      }
    }
    // Live summaries win: they track the streaming turn (reply text and
    // changed files grow as the agent works) while the fetch is a snapshot.
    for (const prompt of livePrompts) {
      byCreatedAt.set(prompt.createdAt, prompt);
    }
    return [...byCreatedAt.values()].sort((left, right) => left.createdAt - right.createdAt);
  }, [fetched, fetchedSessionId, livePrompts, sessionId]);

  useEffect(() => {
    clearHoverPosition();
  }, [clearHoverPosition, sessionId]);

  if (items.length < MIN_TICKS) {
    return null;
  }

  const railHeight = Math.min(items.length * TICK_PITCH_PX, RAIL_MAX_HEIGHT_PX);
  const tickTop = (index: number) =>
    items.length === 1 ? railHeight / 2 : (index / (items.length - 1)) * railHeight;
  const hoveredIndex =
    hoverPosition === null
      ? -1
      : Math.max(0, Math.min(items.length - 1, Math.round(hoverPosition)));
  const hoveredItem = hoveredIndex >= 0 ? items[hoveredIndex] : null;
  // Keep the preview card inside the pane: anchor it downward near the top of
  // the rail, upward near the bottom, centered elsewhere.
  const hoveredFraction = hoveredIndex >= 0 && items.length > 1 ? hoveredIndex / (items.length - 1) : 0.5;
  const cardTransform =
    hoveredFraction < 0.2
      ? 'translateY(-12px)'
      : hoveredFraction > 0.8
        ? 'translateY(calc(-100% + 12px))'
        : 'translateY(-50%)';

  return (
    <div className="pointer-events-none absolute inset-y-0 left-0 z-30 flex items-center">
      <div
        className="pointer-events-auto relative ml-1.5"
        style={{ height: railHeight, width: 20 }}
        onPointerMove={(event) => {
          const target = event.target;
          if (target instanceof Element && target.closest('[data-outline-preview]')) {
            return;
          }
          const bounds = event.currentTarget.getBoundingClientRect();
          const fraction = Math.max(
            0,
            Math.min(1, (event.clientY - bounds.top) / bounds.height)
          );
          scheduleHoverPosition(fraction * (items.length - 1));
        }}
        onPointerLeave={clearHoverPosition}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            clearHoverPosition();
          }
        }}
        role="navigation"
        aria-label="Conversation outline"
      >
        {items.map((item, index) => {
          const hovered = index === hoveredIndex;
          return (
            <button
              key={item.createdAt}
              type="button"
              className="absolute left-0 flex h-3 w-5 -translate-y-1/2 items-center"
              style={{ top: tickTop(index) }}
              onFocus={() => scheduleHoverPosition(index)}
              onClick={() => onNavigate(item.createdAt)}
              aria-label={item.text ? item.text.slice(0, 80) : 'Message with attachments'}
            >
              <span
                className={`h-[2px] w-2 origin-left rounded-full transition-[transform,background-color] duration-100 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform motion-reduce:transition-none ${
                  hovered
                    ? 'bg-[var(--text-primary)]'
                    : 'bg-[color-mix(in_srgb,var(--text-muted)_38%,transparent)]'
                }`}
                style={{
                  transform: `scaleX(${getTickScale(index, hoverPosition)})`,
                }}
              />
            </button>
          );
        })}

        {hoveredItem ? (
          <div
            data-outline-preview
            className="absolute left-full w-max pl-2 transition-[top] duration-100 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
            style={{ top: tickTop(hoveredIndex), transform: cardTransform }}
          >
            <button
              type="button"
              onClick={() => onNavigate(hoveredItem.createdAt)}
              className="block w-[300px] cursor-pointer rounded-[var(--popover-radius)] border border-[var(--popover-border)] bg-[var(--popover-bg)] px-3.5 py-3 text-left shadow-[var(--popover-shadow)]"
            >
              {hoveredItem.text ? (
                <div className="truncate text-[12.5px] font-semibold leading-[1.4] text-[var(--text-primary)]">
                  {hoveredItem.text}
                </div>
              ) : null}
              {hoveredItem.replyText ? (
                <div
                  className={`line-clamp-3 text-[12px] leading-[1.5] text-[var(--text-muted)] ${
                    hoveredItem.text ? 'mt-1.5' : ''
                  }`}
                >
                  {hoveredItem.replyText}
                </div>
              ) : null}
              <OutlineCardChips item={hoveredItem} />
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

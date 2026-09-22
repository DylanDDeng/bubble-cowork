import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motion, useMotionValue, useSpring, useTransform, type MotionValue } from 'motion/react';
import { useAppReducedMotion } from '../hooks/useAppReducedMotion';
import './chat-outline.css';
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

const TICK_PITCH_PX = 12;
const RAIL_MAX_HEIGHT_PX = 520;
const MIN_TICKS = 2;
const HOVER_OFF = -100;
const PREVIEW_DELAY_MS = 120;
const CLOSE_DELAY_MS = 120;
const MOVE_EASE = [0.22, 1, 0.36, 1] as const;

function OutlineTick({ index, position, reduced }: {
  index: number; position: MotionValue<number>; reduced: boolean;
}) {
  const proximity = useTransform(position, value => {
    const distance = Math.abs(index - value);
    return Math.pow(Math.max(0, 1 - distance / 3.5), 2);
  });
  const scale = useTransform(proximity, value => 1 + value * 3);
  const opacity = useTransform(proximity, value => 0.22 + value * 0.78);
  const smoothScale = useSpring(scale, { stiffness: 700, damping: 45, mass: 0.5 });
  const smoothOpacity = useSpring(opacity, { stiffness: 700, damping: 45, mass: 0.5 });
  return <motion.span className="chat-outline-tick" style={{
    scaleX: reduced ? scale : smoothScale,
    opacity: reduced ? opacity : smoothOpacity,
  }} />;
}

function OutlineNavigation({ items, onNavigate }: {
  items: SessionUserPromptSummary[];
  onNavigate: (createdAt: number) => void;
}) {
  const reduced = useAppReducedMotion();
  const position = useMotionValue(HOVER_OFF);
  const paneRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyboardFocus = useRef(false);
  const [index, setIndex] = useState<number | null>(null);
  const [visible, setVisible] = useState(false);
  const [paneHeight, setPaneHeight] = useState(0);
  const [naturalHeight, setNaturalHeight] = useState(0);
  const selectedIndex = index === null ? null : Math.min(index, items.length - 1);
  const item = selectedIndex === null ? null : items[selectedIndex];
  const railHeight = Math.min((items.length - 1) * TICK_PITCH_PX, RAIL_MAX_HEIGHT_PX, Math.max(0, paneHeight - 40));
  const tickTop = (i: number) => i / (items.length - 1) * railHeight;
  const cardHeight = Math.min(naturalHeight + 2, Math.max(0, paneHeight - 24));
  const railOffset = (paneHeight - railHeight) / 2;
  const cardTop = Math.max(12 - railOffset, Math.min(
    tickTop(selectedIndex ?? 0) - cardHeight / 2,
    paneHeight - railOffset - cardHeight - 12,
  ));

  const cancelOpen = () => {
    if (openTimer.current !== null) clearTimeout(openTimer.current);
    openTimer.current = null;
  };
  const cancelClose = () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const close = () => {
    cancelOpen();
    cancelClose();
    setVisible(false);
    position.set(HOVER_OFF);
  };
  const select = (next: number, immediate = false) => {
    cancelClose();
    position.set(next);
    const nearest = Math.max(0, Math.min(items.length - 1, Math.round(next)));
    // Motion values handle every pointer frame; React only changes at a new item.
    setIndex(current => current === nearest ? current : nearest);
    if (immediate) {
      cancelOpen();
      setVisible(true);
    } else if (!visible && openTimer.current === null) {
      openTimer.current = setTimeout(() => {
        openTimer.current = null;
        setVisible(true);
      }, PREVIEW_DELAY_MS);
    }
  };

  useLayoutEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const measure = () => setPaneHeight(pane.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const measure = () => setNaturalHeight(content.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [item]);

  useEffect(() => () => {
    if (openTimer.current !== null) clearTimeout(openTimer.current);
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
  }, []);

  return (
    <div ref={paneRef} className="chat-outline-pane pointer-events-none absolute inset-y-0 left-0 z-30 hidden items-center @[60rem]:flex"
      data-reduced-motion={reduced || undefined}>
      <div ref={railRef} className="chat-outline-rail" style={{ height: railHeight }}
        role="navigation" aria-label="Conversation outline"
        onPointerEnter={cancelClose}
        onPointerMove={event => {
          if (event.pointerType === 'touch' || (event.target instanceof Element && event.target.closest('[data-outline-preview]'))) return;
          keyboardFocus.current = false;
          const bounds = event.currentTarget.getBoundingClientRect();
          const fraction = Math.max(0, Math.min(1, (event.clientY - bounds.top) / (bounds.height || 1)));
          select(fraction * (items.length - 1));
        }}
        onPointerLeave={() => {
          if (keyboardFocus.current) return;
          cancelOpen();
          cancelClose();
          closeTimer.current = setTimeout(close, CLOSE_DELAY_MS);
        }}
        onBlur={event => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            keyboardFocus.current = false;
            close();
          }
        }}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            // Return focus before making the preview inert.
            if (event.target instanceof Element && event.target.closest('[data-outline-preview]')) {
              railRef.current?.querySelectorAll<HTMLButtonElement>('[data-outline-tick]')[selectedIndex ?? 0]?.focus();
            }
            keyboardFocus.current = false;
            close();
            event.stopPropagation();
          }
        }}>
        {items.map((entry, i) => (
          <button key={entry.createdAt} type="button" data-outline-tick
            className="chat-outline-target" style={{ top: tickTop(i), height: Math.max(1, Math.min(TICK_PITCH_PX, railHeight / (items.length - 1))) }}
            onFocus={event => {
              if (event.currentTarget.matches(':focus-visible')) {
                keyboardFocus.current = true;
                select(i, true);
              }
            }}
            onClick={() => onNavigate(entry.createdAt)}
            aria-label={entry.text ? entry.text.slice(0, 80) : 'Message with attachments'}>
            <OutlineTick index={i} position={position} reduced={reduced} />
          </button>
        ))}
        {item && (
          <motion.div data-outline-preview data-state={visible ? 'open' : 'closed'}
            className="chat-outline-preview" inert={!visible} aria-hidden={!visible}
            initial={false} animate={{ y: cardTop }}
            transition={{ duration: reduced || !visible ? 0 : 0.18, ease: MOVE_EASE }}>
            <motion.div className="chat-outline-card" initial={false}
              animate={{ opacity: visible ? 1 : 0, x: visible ? 0 : -4, height: cardHeight }}
              transition={{ duration: reduced ? 0 : 0.16, ease: MOVE_EASE }}>
              <button type="button" className="chat-outline-card-button" tabIndex={visible ? 0 : -1}
                onClick={() => onNavigate(item.createdAt)}>
                <div ref={contentRef} className="chat-outline-content">
                  <div key={item.createdAt} className="chat-outline-copy">
                    {item.text && <div className="chat-outline-title">{item.text}</div>}
                    {item.replyText && <div className={`chat-outline-summary ${item.text ? 'mt-1.5' : ''}`}>{item.replyText}</div>}
                    <OutlineCardChips item={item} />
                  </div>
                </div>
              </button>
            </motion.div>
          </motion.div>
        )}
      </div>
    </div>
  );
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

  if (items.length < MIN_TICKS) return null;
  return <OutlineNavigation key={sessionId} items={items} onNavigate={onNavigate} />;
}

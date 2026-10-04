import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { motion, useMotionValue, useSpring, useTransform, type MotionValue } from 'motion/react';
import { useAppReducedMotion } from '../hooks/useAppReducedMotion';
import './outline-rail.css';

const TICK_PITCH_PX = 12;
const RAIL_MAX_HEIGHT_PX = 520;
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

export type OutlineRailItem = { id: string; title: string; summary?: string; footer?: ReactNode };

export function OutlineRail({ items, onNavigate, label, activeId, className = '' }: {
  items: OutlineRailItem[];
  onNavigate: (id: string) => void;
  label: string;
  activeId?: string | null;
  className?: string;
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
  const [paneWidth, setPaneWidth] = useState(0);
  const [naturalHeight, setNaturalHeight] = useState(0);
  const selectedIndex = index === null ? null : Math.min(index, items.length - 1);
  const item = selectedIndex === null ? null : items[selectedIndex];
  const railHeight = Math.min((items.length - 1) * TICK_PITCH_PX, RAIL_MAX_HEIGHT_PX, Math.max(0, paneHeight - 40));
  const tickTop = (i: number) => i / Math.max(1, items.length - 1) * railHeight;
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
    const measure = () => { setPaneHeight(pane.clientHeight); setPaneWidth(pane.parentElement?.clientWidth ?? 0); };
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
    <div ref={paneRef} className={`bubble-outline-pane ${className}`}
      data-reduced-motion={reduced || undefined}>
      <div ref={railRef} className="chat-outline-rail" style={{ height: railHeight }}
        role="navigation" aria-label={label}
        onPointerEnter={cancelClose}
        onPointerMove={event => {
          if (event.pointerType === 'touch' || (event.target instanceof Element && event.target.closest('[data-outline-preview]'))) return;
          keyboardFocus.current = false;
          const bounds = event.currentTarget.getBoundingClientRect();
          const fraction = Math.max(0, Math.min(1, (event.clientY - bounds.top) / (bounds.height || 1)));
          select(fraction * Math.max(1, items.length - 1));
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
          <button key={entry.id} type="button" data-outline-tick
            className="chat-outline-target" style={{ top: tickTop(i), height: items.length === 1 ? TICK_PITCH_PX : Math.max(1, Math.min(TICK_PITCH_PX, railHeight / (items.length - 1))) }}
            onFocus={event => {
              if (event.currentTarget.matches(':focus-visible')) {
                keyboardFocus.current = true;
                select(i, true);
              }
            }}
            onClick={() => onNavigate(entry.id)}
            aria-label={entry.title} aria-current={entry.id === activeId ? 'location' : undefined}>
            <OutlineTick index={i} position={position} reduced={reduced} />
          </button>
        ))}
        {item && (
          <motion.div data-outline-preview data-state={visible ? 'open' : 'closed'}
            className="chat-outline-preview" style={{ width: Math.max(0, Math.min(328, paneWidth - 48)) }} inert={!visible} aria-hidden={!visible}
            initial={false} animate={{ y: cardTop }}
            transition={{ duration: reduced || !visible ? 0 : 0.18, ease: MOVE_EASE }}>
            <motion.div className="chat-outline-card" initial={false}
              animate={{ opacity: visible ? 1 : 0, x: visible ? 0 : -4, height: cardHeight }}
              transition={{ duration: reduced ? 0 : 0.16, ease: MOVE_EASE }}>
              <button type="button" className="chat-outline-card-button" tabIndex={visible ? 0 : -1}
                onClick={() => onNavigate(item.id)}>
                <div ref={contentRef} className="chat-outline-content">
                  <div key={item.id} className="chat-outline-copy">
                    {item.title && <div className="chat-outline-title">{item.title}</div>}
                    {item.summary && <div className="chat-outline-summary mt-1.5">{item.summary}</div>}
                    {item.footer}
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

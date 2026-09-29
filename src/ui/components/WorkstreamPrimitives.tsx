import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { useAppReducedMotion } from '../hooks/useAppReducedMotion';

/** Retain the body while closing, and reverse an in-flight close without remounting it. */
export function WorkstreamCollapse({ open, children }: { open: boolean; children: ReactNode }) {
  const reducedMotion = useAppReducedMotion();
  const [phase, setPhase] = useState<'opening' | 'expanded' | 'closing' | 'collapsed'>(open ? 'expanded' : 'collapsed');
  const desiredOpen = useRef(open);
  useLayoutEffect(() => {
    desiredOpen.current = open;
    setPhase(previous => reducedMotion ? open ? 'expanded' : 'collapsed'
      : open ? previous === 'collapsed' ? 'opening' : 'expanded'
      : previous === 'collapsed' ? previous : 'closing');
  }, [open, reducedMotion]);
  useEffect(() => {
    if (phase !== 'opening') return;
    const frame = requestAnimationFrame(() => { if (desiredOpen.current) setPhase('expanded'); });
    return () => cancelAnimationFrame(frame);
  }, [phase]);
  if (reducedMotion) return open ? <div>{children}</div> : null;
  if (phase === 'collapsed') return null;
  const expanded = phase === 'expanded';
  return <motion.div
    data-workstream-collapse={phase}
    aria-hidden={!open || undefined}
    inert={!open || undefined}
    initial={false}
    animate={expanded ? { height: 'auto', opacity: 1 } : { height: 0, opacity: 0 }}
    transition={{ duration: 0.3, ease: [0.19, 1, 0.22, 1] }}
    onAnimationComplete={() => { if (!desiredOpen.current) setPhase('collapsed'); }}
    style={{ overflow: 'hidden', pointerEvents: expanded ? 'auto' : 'none' }}
  >{children}</motion.div>;
}

/** Active summaries remain readable for one second; terminal states replace them immediately. */
export function WorkstreamActivityLabel({ children, active, activityKey = children }: { children: string; active: boolean; activityKey?: string }) {
  const reducedMotion = useAppReducedMotion();
  const [shown, setShown] = useState({ text: children, key: activityKey });
  const displayedAt = useRef(0);
  useEffect(() => {
    if (!active || activityKey === shown.key) return;
    const update = () => {
      displayedAt.current = Date.now();
      setShown({ text: children, key: activityKey });
    };
    const remaining = 1000 - (Date.now() - displayedAt.current);
    if (remaining <= 0) { update(); return; }
    const timer = setTimeout(update, remaining);
    return () => clearTimeout(timer);
  }, [children, active, activityKey, shown.key]);
  useEffect(() => { displayedAt.current = Date.now(); }, []);
  const text = !active || activityKey === shown.key ? children : shown.text;
  return (
    <span className="workstream-activity-label min-w-0 truncate">
      {text}
      {active && !reducedMotion && <span aria-hidden="true" className="workstream-activity-shimmer">{text}</span>}
    </span>
  );
}

export function WorkstreamElapsed({ startedAt, durationMs, completedAt, running }: {
  startedAt?: number; durationMs?: number; completedAt?: number; running: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running || startedAt == null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, startedAt]);
  const duration = durationMs ?? (startedAt != null && (running || completedAt != null)
    ? (completedAt ?? now) - startedAt : undefined);
  if (duration == null || !Number.isFinite(duration) || duration < 1000) return null;
  return <span className="shrink-0 tabular-nums text-[var(--text-muted)]" data-workstream-elapsed> · {formatWorkstreamElapsed(duration)}</span>;
}

export function formatWorkstreamElapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m${seconds % 60 ? ` ${seconds % 60}s` : ''}` : `${seconds}s`;
}

/** Follow new activity until the reader deliberately scrolls back into history. */
export function WorkstreamScrollArea({ children, followKey }: { children: ReactNode; followKey?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const lastScrollTop = useRef(0);
  const [edges, setEdges] = useState({ top: false, bottom: false });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      // Scroll events can arrive after ResizeObserver; honor the actual reader
      // position before an output resize has a chance to pull it back down.
      if (element.scrollTop < lastScrollTop.current - 1
        && element.scrollHeight - element.clientHeight - element.scrollTop >= 24) following.current = false;
      if (followKey && following.current) element.scrollTop = element.scrollHeight;
      lastScrollTop.current = element.scrollTop;
      setEdges({ top: element.scrollTop > 1, bottom: element.scrollHeight - element.clientHeight - element.scrollTop > 1 });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [followKey]);
  return (
    <div ref={ref} className="workstream-scroll-area" data-fade-top={edges.top} data-fade-bottom={edges.bottom}
      onPointerDownCapture={(event) => {
        if ((event.target as Element).closest('button')) following.current = false;
      }}
      onScroll={(event) => {
        const element = event.currentTarget;
        const remaining = element.scrollHeight - element.clientHeight - element.scrollTop;
        following.current = remaining < 24;
        lastScrollTop.current = element.scrollTop;
        setEdges({ top: element.scrollTop > 1, bottom: remaining > 1 });
      }}>
      <div>{children}</div>
    </div>
  );
}

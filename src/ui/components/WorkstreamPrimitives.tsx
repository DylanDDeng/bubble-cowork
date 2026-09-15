import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { useAppReducedMotion } from '../hooks/useAppReducedMotion';

/** Shared disclosure motion for a turn and its individual activities. */
export function WorkstreamCollapse({ open, children }: { open: boolean; children: ReactNode }) {
  const reducedMotion = useAppReducedMotion();
  return (
    <AnimatePresence initial={false}>
      {open && (
        <CollapseBody reducedMotion={reducedMotion}>{children}</CollapseBody>
      )}
    </AnimatePresence>
  );
}

function CollapseBody({ children, reducedMotion }: { children: ReactNode; reducedMotion: boolean }) {
  const present = useIsPresent();
  return (
    <motion.div
      aria-hidden={!present || undefined}
      inert={!present || undefined}
      initial={{ height: reducedMotion ? 'auto' : 0, opacity: 0, y: reducedMotion ? 0 : -8 }}
      animate={{ height: 'auto', opacity: 1, y: 0, transitionEnd: { overflow: 'visible' } }}
      exit={{ height: reducedMotion ? 'auto' : 0, opacity: 0, y: reducedMotion ? 0 : -8, overflow: 'hidden',
        transition: { duration: reducedMotion ? 0 : 0.15 } }}
      transition={{ duration: reducedMotion ? 0 : 0.22, ease: [0.33, 1, 0.68, 1] }}
      style={{ overflow: 'hidden' }}
    >{children}</motion.div>
  );
}

export function WorkstreamActivityLabel({ children, active }: { children: string; active: boolean }) {
  const reducedMotion = useAppReducedMotion();
  return (
    <motion.span key={children} className="workstream-activity-label min-w-0 truncate"
      initial={reducedMotion ? false : { opacity: 0, y: 3 }}
      animate={{ opacity: 1, y: 0 }} transition={{ duration: reducedMotion ? 0 : 0.15 }}>
      {children}
      {active && !reducedMotion && (
        <span aria-hidden="true" className="workstream-activity-shimmer">{children}</span>
      )}
    </motion.span>
  );
}

/** Follow new activity until the reader deliberately scrolls back into history. */
export function WorkstreamScrollArea({ children, followKey }: { children: ReactNode; followKey?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [edges, setEdges] = useState({ top: false, bottom: false });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      if (followKey && following.current) element.scrollTop = element.scrollHeight;
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
        setEdges({ top: element.scrollTop > 1, bottom: remaining > 1 });
      }}>
      <div>{children}</div>
    </div>
  );
}

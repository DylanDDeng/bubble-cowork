import { useEffect, useState, type RefObject } from 'react';
import { ArrowDown } from './icons';

/** A transcript-local affordance; scroll updates only rerender this button. */
export function JumpToLatestButton({ scrollContainerRef, threshold, onJump }: {
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  threshold: number;
  onJump: () => void;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      setVisible(container.scrollHeight - container.scrollTop - container.clientHeight >= threshold);
    };
    const scheduleMeasure = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    container.addEventListener('scroll', scheduleMeasure, { passive: true });
    // Account for pane resizing, expanded work, and media finishing loading.
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(container);
    const transcript = container.querySelector('.message-container');
    if (transcript) observer.observe(transcript);
    scheduleMeasure();
    return () => {
      container.removeEventListener('scroll', scheduleMeasure);
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [scrollContainerRef, threshold]);

  if (!visible) return null;

  return (
    <button
      type="button"
      aria-label="Scroll to latest turn"
      title="Scroll to latest turn"
      onClick={onJump}
      className="absolute bottom-3 left-1/2 z-20 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] no-drag"
    >
      <ArrowDown className="h-[18px] w-[18px]" aria-hidden="true" />
    </button>
  );
}

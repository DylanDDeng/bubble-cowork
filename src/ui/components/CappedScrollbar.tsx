import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';

/**
 * A capped, draggable scrollbar drawn over a scroll container in place of
 * the native one. The native thumb is strictly proportional, so a page that
 * is only a few screens tall gets a thumb that fills most of the track; this
 * one clamps the thumb between a minimum and a maximum height, the way the
 * sidebar's does, so it reads as a handle rather than a bar.
 *
 * The host must hide its native scrollbar (`capped-scrollbar-host`) and sit
 * inside a `relative` wrapper, which is where the track is positioned.
 */

const DEFAULT_INSET = 14;
const DEFAULT_MIN_THUMB_HEIGHT = 52;
const DEFAULT_MAX_THUMB_HEIGHT = 220;

type ThumbMetrics = {
  visible: boolean;
  thumbHeight: number;
  thumbTop: number;
};

export function CappedScrollbar({
  scrollRef,
  inset = DEFAULT_INSET,
  minThumbHeight = DEFAULT_MIN_THUMB_HEIGHT,
  maxThumbHeight = DEFAULT_MAX_THUMB_HEIGHT,
  className = 'right-1',
}: {
  scrollRef: RefObject<HTMLElement | null>;
  /** Track padding from the top and bottom of the scroll container. */
  inset?: number;
  minThumbHeight?: number;
  maxThumbHeight?: number;
  /** Horizontal placement of the track inside the wrapper. */
  className?: string;
}) {
  const [metrics, setMetrics] = useState<ThumbMetrics>({
    visible: false,
    thumbHeight: 0,
    thumbTop: 0,
  });

  const update = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;

    const maxScrollTop = element.scrollHeight - element.clientHeight;
    const trackHeight = Math.max(0, element.clientHeight - inset * 2);
    if (maxScrollTop <= 1 || trackHeight <= 0) {
      setMetrics((current) =>
        current.visible ? { visible: false, thumbHeight: 0, thumbTop: 0 } : current
      );
      return;
    }

    const proportionalHeight = trackHeight * (element.clientHeight / element.scrollHeight);
    const thumbHeight = Math.min(
      trackHeight,
      maxThumbHeight,
      Math.max(minThumbHeight, proportionalHeight)
    );
    const thumbTravel = Math.max(0, trackHeight - thumbHeight);
    const thumbTop = thumbTravel * (element.scrollTop / maxScrollTop);

    setMetrics((current) =>
      current.visible &&
      Math.abs(current.thumbHeight - thumbHeight) < 0.5 &&
      Math.abs(current.thumbTop - thumbTop) < 0.5
        ? current
        : { visible: true, thumbHeight, thumbTop }
    );
  }, [inset, maxThumbHeight, minThumbHeight, scrollRef]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const frame = requestAnimationFrame(update);
    element.addEventListener('scroll', update, { passive: true });
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(element);
    Array.from(element.children).forEach((child) => resizeObserver.observe(child));
    // Content that mounts later (cards, replies) changes the scroll height
    // without resizing anything already observed.
    const mutationObserver = new MutationObserver(() => {
      Array.from(element.children).forEach((child) => resizeObserver.observe(child));
      update();
    });
    mutationObserver.observe(element, { childList: true, subtree: true });

    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener('scroll', update);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [scrollRef, update]);

  const handleTrackMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const element = scrollRef.current;
    if (!element) return;

    const rect = event.currentTarget.getBoundingClientRect();
    const thumbTravel = rect.height - metrics.thumbHeight;
    const maxScrollTop = element.scrollHeight - element.clientHeight;
    if (thumbTravel <= 0 || maxScrollTop <= 0) return;

    const nextThumbTop = Math.min(
      thumbTravel,
      Math.max(0, event.clientY - rect.top - metrics.thumbHeight / 2)
    );
    element.scrollTop = (nextThumbTop / thumbTravel) * maxScrollTop;
  };

  const handleThumbMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const element = scrollRef.current;
    if (!element) return;

    const startY = event.clientY;
    const startScrollTop = element.scrollTop;
    const trackHeight = element.clientHeight - inset * 2;
    const thumbTravel = trackHeight - metrics.thumbHeight;
    const maxScrollTop = element.scrollHeight - element.clientHeight;
    if (thumbTravel <= 0 || maxScrollTop <= 0) return;

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';

    const handleMouseMove = (moveEvent: MouseEvent) => {
      element.scrollTop = startScrollTop + ((moveEvent.clientY - startY) / thumbTravel) * maxScrollTop;
    };
    const finishDrag = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', finishDrag);
      window.removeEventListener('blur', finishDrag);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', finishDrag);
    window.addEventListener('blur', finishDrag);
  };

  if (!metrics.visible) return null;

  return (
    <div
      className={`absolute w-[7px] ${className}`}
      style={{ top: inset, bottom: inset }}
      data-capped-scrollbar-track
      onMouseDown={handleTrackMouseDown}
    >
      <div
        className="absolute right-0 top-0 w-[7px] cursor-grab rounded-full bg-[var(--border)] transition-colors hover:bg-[var(--text-muted)] active:cursor-grabbing"
        data-capped-scrollbar-thumb
        onMouseDown={handleThumbMouseDown}
        style={{
          height: metrics.thumbHeight,
          transform: `translateY(${metrics.thumbTop}px)`,
        }}
      />
    </div>
  );
}

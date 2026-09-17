import { useEffect, useRef } from 'react';
import { useAppReducedMotion } from '../hooks/useAppReducedMotion';

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => value * value * (3 - 2 * value);
const cubic = (value: number) => value < .5 ? 4 * value ** 3 : 1 - (-2 * value + 2) ** 3 / 2;
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const random = (a: number, b: number) => mix(a, b, Math.random());

/** A time-based dot field, not a progress indicator or a partial model output. */
export function ImageGenerationPlaceholder({ thumbnail = false, paused = false, hidden = false, label = 'Generating image…' }: {
  thumbnail?: boolean; paused?: boolean; hidden?: boolean; label?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = useAppReducedMotion();
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context || hidden) return;
    const durations = [4500, 6330, 5600, 5750, 3600, 2400].map(value => value * 1.2 * random(1, 1.35));
    const phases = durations.map(() => Math.random());
    const ranges = [
      [random(.1, .32), random(.68, .9)], [random(.1, .32), random(.68, .9)],
      [random(.68, .9), random(.1, .32)], [random(.68, .9), random(.1, .32)],
      [random(.42, .52), random(.62, .75)], [random(.5, .62), random(.74, .9)],
    ];
    let frame = 0, start = 0, last = 0, width = 0, height = 0, dpr = 1;
    let visible = true;
    const spacing = thumbnail ? 6 : 14, radius = thumbnail ? .75 : 1.5;
    const animate = !reduced && !paused;
    const draw = (now: number) => {
      frame = 0;
      if (!visible || document.hidden || !width || !height) return;
      if (animate && last && now - last < 1000 / 30) { frame = requestAnimationFrame(draw); return; }
      last = now;
      start ||= now;
      const time = animate ? now - start : 0;
      const values = durations.map((duration, index) => {
        const phase = (time / duration + phases[index]) % 1;
        const triangle = phase <= .5 ? phase * 2 : 2 - phase * 2;
        return mix(ranges[index][0], ranges[index][1], index === 0 || index === 2 ? cubic(triangle) : smooth(triangle));
      });
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = getComputedStyle(canvas).color;
      const columns = Math.max(1, Math.floor(width / spacing)), rows = Math.max(1, Math.floor(height / spacing));
      const left = (width - (columns - 1) * spacing) / 2, top = (height - (rows - 1) * spacing) / 2;
      for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
        const nx = columns === 1 ? .5 : x / (columns - 1), ny = rows === 1 ? .5 : y / (rows - 1);
        const field = (index: number) => 1 - smooth(clamp(Math.hypot(nx - values[index], ny - values[index + 1]) / (.78 * values[index / 2 + 4])));
        const alpha = clamp(field(0) * 1.2 + field(2) * .82) ** 1.18;
        if (alpha <= .03) continue;
        context.globalAlpha = alpha;
        context.beginPath();
        context.arc(left + x * spacing, top + y * spacing, radius, 0, Math.PI * 2);
        context.fill();
      }
      if (animate) frame = requestAnimationFrame(draw);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(draw); };
    const resize = new ResizeObserver(() => {
      const bounds = canvas.getBoundingClientRect();
      width = Math.floor(bounds.width); height = Math.floor(bounds.height);
      dpr = Math.max(1, window.devicePixelRatio || 1);
      canvas.width = Math.floor(width * dpr); canvas.height = Math.floor(height * dpr);
      schedule();
    });
    const intersection = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; schedule(); });
    // Repaint static/reduced-motion fields too when the theme changes.
    const theme = new MutationObserver(schedule);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    resize.observe(canvas); intersection.observe(canvas);
    document.addEventListener('visibilitychange', schedule);
    return () => {
      cancelAnimationFrame(frame); resize.disconnect(); intersection.disconnect(); theme.disconnect();
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [thumbnail, paused, hidden, reduced]);

  return <div className="image-generation-placeholder" data-thumbnail={thumbnail} data-animated={!paused && !hidden && !reduced} role="status" aria-busy="true" aria-label={label}>
    <canvas ref={canvasRef} aria-hidden="true" />
  </div>;
}

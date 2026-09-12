import { useAppReducedMotion } from '../hooks/useAppReducedMotion';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import * as DropdownMenu from './ui/dropdown-menu';
import './reasoning-picker.css';

// Catalogs can return descending tiers. Order known tiers without inventing any.
const tierOrder = [
  'off',
  'none',
  'minimal',
  'low',
  'medium',
  'on',
  'high',
  'xhigh',
  'max',
  'ultra',
];
export function orderedEfforts<T extends string>(options: readonly T[]): T[] {
  const unique = [...new Set(options)];
  return unique.every((option) => tierOrder.includes(option))
    ? unique.sort((a, b) => tierOrder.indexOf(a) - tierOrder.indexOf(b))
    : unique;
}

export function ReasoningEffortSlider<T extends string>({
  options,
  value,
  onChange,
  formatLabel,
  label = 'Reasoning',
  fast = false,
  inactive = false,
  renderHeader,
  preserveOrder = false,
}: {
  options: readonly T[];
  value: T | null;
  onChange: (value: T) => void;
  formatLabel: (value: T) => string;
  label?: string;
  fast?: boolean;
  inactive?: boolean;
  renderHeader?: (previewLabel: string) => ReactNode;
  preserveOrder?: boolean;
}) {
  const reducedMotion = useAppReducedMotion();
  const tiers = preserveOrder ? [...new Set(options)] : orderedEfforts(options);
  const signature = tiers.join('\0');
  const selected = value === null ? -1 : tiers.indexOf(value);
  const [preview, setPreview] = useState<number | null>(null);
  const [pressed, setPressed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const drag = useRef<{ pointer: number; index: number } | null>(null);
  const wheel = useRef({ delta: 0, time: 0 });
  const index = Math.max(0, Math.min(tiers.length - 1, preview ?? selected));
  const percent = tiers.length > 1 ? (index / (tiers.length - 1)) * 100 : 0;
  const explicit = preview !== null || selected >= 0;
  const atMax = explicit && tiers.length > 1 && index === tiers.length - 1;
  const disabled = tiers.length < 2 || inactive;
  const previousMax = useRef(atMax);
  const [burst, setBurst] = useState(0);
  useEffect(() => {
    if (atMax && !previousMax.current && !inactive)
      setBurst((sequence) => sequence + 1);
    previousMax.current = atMax;
  }, [atMax, inactive]);

  function cancel() {
    drag.current = null;
    setPressed(false);
    setPreview(null);
  }
  useEffect(cancel, [signature, value, inactive]);

  function commit(next: number) {
    const tier = tiers[Math.max(0, Math.min(tiers.length - 1, next))];
    if (tier !== undefined && tier !== value) onChange(tier);
  }

  // A non-passive listener consumes only deliberate scrolling over the focused
  // slider. The surrounding model list and popup keep their normal scrolling.
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => {
    const el = input.current;
    if (!el || disabled) return;
    const onWheel = (event: WheelEvent) => {
      if (document.activeElement !== el || drag.current) return;
      event.preventDefault();
      event.stopPropagation();
      const delta =
        (Math.abs(event.deltaX) > Math.abs(event.deltaY)
          ? event.deltaX
          : -event.deltaY) *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1);
      const now = performance.now();
      if (
        now - wheel.current.time > 160 ||
        Math.sign(delta) !== Math.sign(wheel.current.delta)
      )
        wheel.current.delta = 0;
      wheel.current.time = now;
      wheel.current.delta += delta;
      if (Math.abs(wheel.current.delta) >= 30) {
        commitRef.current(Number(el.value) + Math.sign(wheel.current.delta));
        wheel.current.delta = 0;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [disabled]);

  if (!tiers.length) return null;
  return (
    <div
      className="effort-picker"
      data-reduced-motion={reducedMotion || undefined}
      data-fast={fast || undefined}
    >
      {renderHeader ? (
        renderHeader(explicit ? formatLabel(tiers[index]) : 'Default')
      ) : (
        <div className="effort-picker-heading">
          <span>{label}</span>
          <span className="effort-picker-value">
            {explicit ? formatLabel(tiers[index]) : 'Default'}
          </span>
        </div>
      )}
      <div className="effort-picker-control">
        <div
          className="effort-picker-rail"
          aria-hidden="true"
          data-max={atMax || undefined}
          data-unset={!explicit || undefined}
        >
          <motion.div
            className="effort-picker-fill"
            initial={false}
            animate={{ width: `${percent}%` }}
            transition={{
              duration: reducedMotion ? 0 : pressed ? 0.15 : 0.3,
              ease: [0.23, 1, 0.32, 1],
            }}
          >
            {atMax && <span className="effort-picker-flow" />}
            {fast && <span className="effort-picker-speed" />}
          </motion.div>
          <div className="effort-picker-stops">
            {tiers.map((tier) => (
              <i
                key={tier}
                data-filled={
                  (explicit && tiers.indexOf(tier) <= index) || undefined
                }
              />
            ))}
          </div>
          <motion.span
            className="effort-picker-thumb-position"
            initial={false}
            animate={{ left: `${percent}%`, opacity: explicit ? 1 : 0.5 }}
            transition={{
              duration: reducedMotion ? 0 : pressed ? 0.15 : 0.3,
              ease: [0.23, 1, 0.32, 1],
            }}
          >
            {atMax && burst > 0 && !reducedMotion && (
              <motion.span
                key={burst}
                className="effort-picker-burst"
                initial={{ opacity: 0.5, scale: 0.8 }}
                animate={{ opacity: 0, scale: 1.65 }}
                transition={{ duration: 0.5, ease: 'easeOut' }}
              />
            )}
            <motion.span
              className="effort-picker-thumb"
              initial={false}
              animate={{
                scale: (hovered || pressed) && !disabled ? 32 / 28 : 1,
              }}
              transition={
                reducedMotion
                  ? { duration: 0 }
                  : {
                      type: 'spring',
                      stiffness: hovered || pressed ? 420 : 220,
                      damping: hovered || pressed ? 38 : 26,
                      mass: 1,
                    }
              }
            />
          </motion.span>
        </div>
        <DropdownMenu.Item
          role="slider"
          closeOnClick={false}
          disabled={disabled}
          className="effort-picker-input"
          render={
            <input
              ref={input}
              type="range"
              min={0}
              max={Math.max(0, tiers.length - 1)}
              step={1}
              value={index}
              disabled={disabled}
              aria-label={label}
              aria-valuetext={explicit ? formatLabel(tiers[index]) : 'Default'}
              onPointerEnter={() => setHovered(true)}
              onPointerLeave={() => setHovered(false)}
              onPointerDown={(event) => {
                if (event.button !== 0 || disabled) return;
                event.stopPropagation();
                event.currentTarget.focus();
                event.currentTarget.setPointerCapture(event.pointerId);
                drag.current = { pointer: event.pointerId, index };
                setPressed(true);
              }}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (drag.current) {
                  drag.current.index = next;
                  setPreview(next);
                } else commit(next);
              }}
              onPointerUp={(event) => {
                if (drag.current?.pointer !== event.pointerId) return;
                const next = drag.current.index;
                cancel();
                commit(next);
              }}
              onPointerCancel={cancel}
              onLostPointerCapture={cancel}
              onBlur={cancel}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  cancel();
                  return;
                }
                if (
                  [
                    'ArrowLeft',
                    'ArrowRight',
                    'ArrowUp',
                    'ArrowDown',
                    'Home',
                    'End',
                    'PageUp',
                    'PageDown',
                  ].includes(event.key)
                ) {
                  event.stopPropagation();
                  event.preventDefault();
                  (
                    event as typeof event & {
                      preventBaseUIHandler?: () => void;
                    }
                  ).preventBaseUIHandler?.();
                  commit(
                    event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? tiers.length - 1
                        : index +
                          (['ArrowRight', 'ArrowUp', 'PageUp'].includes(
                            event.key,
                          )
                            ? 1
                            : -1),
                  );
                }
              }}
            />
          }
        />
      </div>
    </div>
  );
}

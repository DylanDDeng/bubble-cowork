import { useState } from 'react';
import type { CodexContextSnapshot } from '../utils/context-usage';

const RING_CIRCUMFERENCE = 37.7;

function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return `${Math.round(value)}`;
}

function UsageRing({ percent, size = 'h-4 w-4' }: { percent: number; size?: string }) {
  const progress = Math.min(100, Math.max(0, percent));
  const strokeDashoffset = RING_CIRCUMFERENCE * (1 - progress / 100);

  return (
    <svg
      className={`${size} -rotate-90`}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="var(--border)"
        strokeWidth="2"
      />
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="var(--text-secondary)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={RING_CIRCUMFERENCE}
        strokeDashoffset={strokeDashoffset}
      />
    </svg>
  );
}

export function CodexContextIndicator({ snapshot }: { snapshot: CodexContextSnapshot }) {
  const [open, setOpen] = useState(false);

  return (
    <div
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <button
        type="button"
        className="flex h-8 w-8 items-center justify-center rounded-[6px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
        aria-label="Context window usage"
      >
        <UsageRing percent={snapshot.percent} />
      </button>

      {open && (
        <div className="absolute bottom-full left-1/2 z-40 mb-1.5 w-[156px] -translate-x-1/2 rounded-[8px] border border-[color-mix(in_srgb,var(--border)_72%,transparent)] bg-[var(--bg-primary)] px-2.5 py-2 text-[13px] font-normal leading-5 text-[var(--text-primary)] shadow-[0_18px_44px_rgba(15,23,42,0.08)]">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[var(--text-secondary)]">Context window</div>
            <UsageRing percent={snapshot.percent} size="h-[18px] w-[18px]" />
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className="text-[var(--text-secondary)]">Used</span>
            <span>{formatCompact(snapshot.used)}</span>
          </div>
          <div className="mt-0.5 flex items-center justify-between gap-2">
            <span className="text-[var(--text-secondary)]">Limit</span>
            <span>{formatCompact(snapshot.total)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

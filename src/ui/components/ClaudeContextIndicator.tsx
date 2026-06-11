import { useState } from 'react';
import type { ClaudeContextSnapshot } from '../utils/context-usage';

const RING_CIRCUMFERENCE = 37.7;

function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return `${Math.round(value)}`;
}

function formatCurrency(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0.0000';
  return `$${value.toFixed(value >= 0.01 ? 4 : 6)}`;
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

export function ClaudeContextIndicator({
  snapshot,
  modelLabel,
}: {
  snapshot: ClaudeContextSnapshot | null;
  modelLabel?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const resolvedModelLabel = modelLabel || snapshot?.model || 'Claude';
  const percent = snapshot?.percent || 0;

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
        aria-label="Claude context and cost"
      >
        <UsageRing percent={percent} />
      </button>

      {open && (
        <div className="absolute bottom-full right-0 z-40 mb-1.5 w-[240px] max-w-[calc(100vw-1.5rem)] rounded-[8px] border border-[color-mix(in_srgb,var(--border)_72%,transparent)] bg-[var(--bg-primary)] px-2.5 py-2 text-[13px] font-normal leading-5 text-[var(--text-primary)] shadow-[0_18px_44px_rgba(15,23,42,0.08)]">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 truncate text-[var(--text-secondary)]">{resolvedModelLabel}</div>
            <UsageRing percent={percent} size="h-[18px] w-[18px]" />
          </div>

          {snapshot ? (
            <>
              <MetricRow label="Cost" value={formatCurrency(snapshot.costUSD)} />
              <MetricRow label="Used" value={formatCompact(snapshot.used)} />
              {snapshot.total > 0 ? <MetricRow label="Limit" value={formatCompact(snapshot.total)} /> : null}
              <Divider />
              <MetricRow label="Input" value={formatCompact(snapshot.inputTokens)} />
              <MetricRow label="Output" value={formatCompact(snapshot.outputTokens)} />
              <MetricRow label="Cache read" value={formatCompact(snapshot.cacheReadTokens)} />
              <MetricRow label="Cache write" value={formatCompact(snapshot.cacheCreationTokens)} />
              {snapshot.maxOutputTokens > 0 ? (
                <MetricRow label="Max output" value={formatCompact(snapshot.maxOutputTokens)} />
              ) : null}
              {snapshot.webSearchRequests > 0 ? (
                <MetricRow label="Web searches" value={formatCompact(snapshot.webSearchRequests)} />
              ) : null}
              <div className="mt-1.5 border-t border-[var(--border)] pt-1.5 text-[11px] leading-4 text-[var(--text-muted)]">
                Latest usage for this model
              </div>
            </>
          ) : (
            <div className="mt-1.5 border-t border-[var(--border)] pt-1.5 text-[12px] leading-5 text-[var(--text-secondary)]">
              Waiting for usage from this model.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-0.5 flex items-center justify-between gap-2">
      <span className="shrink-0 text-[var(--text-secondary)]">{label}</span>
      <span className="min-w-0 truncate text-right">{value}</span>
    </div>
  );
}

function Divider() {
  return <div className="my-1.5 border-t border-[var(--border)]" />;
}

import { useState } from 'react';
import type { ClaudeContextSnapshot } from '../utils/context-usage';

function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return `${Math.round(value)}`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function getIndicatorTone(usageRatio: number) {
  if (usageRatio >= 0.85) {
    return {
      stroke: '#DC2626',
      track: 'rgba(220, 38, 38, 0.18)',
    };
  }

  if (usageRatio >= 0.65) {
    return {
      stroke: '#D97706',
      track: 'rgba(217, 119, 6, 0.18)',
    };
  }

  if (usageRatio >= 0.4) {
    return {
      stroke: '#D4A017',
      track: 'rgba(212, 160, 23, 0.18)',
    };
  }

  return {
    stroke: 'var(--text-secondary)',
    track: 'var(--border)',
  };
}

export function ClaudeContextIndicator({
  snapshot,
  modelLabel,
  emptyMessage = 'Waiting for the first Claude response',
}: {
  snapshot: ClaudeContextSnapshot | null;
  modelLabel?: string | null;
  emptyMessage?: string;
}) {
  const [open, setOpen] = useState(false);
  const tone = snapshot ? getIndicatorTone(snapshot.usageRatio) : { stroke: 'var(--text-muted)', track: 'var(--border)' };
  const sweep = snapshot ? Math.max(0, Math.min(snapshot.usageRatio, 1)) * 360 : 360;
  const resolvedModelLabel = snapshot?.model || modelLabel || 'Claude';

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
        className="flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-[var(--bg-tertiary)]"
        title="Claude context usage"
        aria-label="Claude context usage"
      >
        <span
          className="relative block h-3.5 w-3.5 rounded-full"
          style={{
            background: `conic-gradient(${tone.stroke} 0deg ${sweep}deg, ${tone.track} ${sweep}deg 360deg)`,
          }}
        >
          <span
            className="absolute inset-[2px] rounded-full bg-[var(--bg-secondary)]"
          />
        </span>
      </button>

      {open && (
        <div className="absolute bottom-full left-1/2 z-40 mb-2 w-[248px] -translate-x-1/2 rounded-[20px] border border-[var(--border)] bg-[var(--bg-secondary)] p-4 text-[var(--text-primary)] shadow-[0_18px_48px_rgba(0,0,0,0.12)]">
          <MetricRow label="Model" value={resolvedModelLabel} mono />
          {snapshot ? (
            <>
              <MetricRow label="Used" value={formatCompact(snapshot.used)} />
              <MetricRow label="Total" value={formatCompact(snapshot.total)} />
              <MetricRow label="Usage" value={formatPercent(snapshot.usageRatio)} />

              <Divider />

              <MetricRow label="Cache Read" value={formatCompact(snapshot.cacheReadTokens)} />
              <MetricRow label="Cache Creation" value={formatCompact(snapshot.cacheCreationTokens)} />
              <MetricRow label="Output Tokens" value={formatCompact(snapshot.outputTokens)} />

              <div className="mt-4 border-t border-[var(--border)] pt-3 text-[12px] leading-5 text-[var(--text-secondary)]">
                Estimated from the most recent response
              </div>
            </>
          ) : (
            <div className="mt-3 border-t border-[var(--border)] pt-3 text-[12px] leading-5 text-[var(--text-secondary)]">
              {emptyMessage}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MetricRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <div className="text-[13px] text-[var(--text-secondary)]">{label}</div>
      <div className={`text-right text-[13px] font-medium ${mono ? 'font-mono text-[12px]' : ''}`}>{value}</div>
    </div>
  );
}

function Divider() {
  return <div className="my-2 border-t border-[var(--border)]" />;
}

import { useState } from 'react';
import type { ClaudeContextSnapshot } from '../utils/context-usage';

function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return `${Math.round(value)}`;
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
  const resolvedModelLabel = snapshot?.model || modelLabel || 'Claude';
  const hasSnapshot = !!snapshot;

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
        title="Claude token details"
        aria-label="Claude token details"
      >
        <span
          className="relative block h-3.5 w-3.5 rounded-full border"
          style={{
            borderColor: hasSnapshot ? 'var(--text-secondary)' : 'var(--border)',
            backgroundColor: 'transparent',
          }}
        >
          <span
            className="absolute inset-[3px] rounded-full"
            style={{
              backgroundColor: hasSnapshot ? 'var(--text-secondary)' : 'var(--text-muted)',
              opacity: hasSnapshot ? 0.95 : 0.6,
            }}
          />
        </span>
      </button>

      {open && (
        <div className="absolute bottom-full left-1/2 z-40 mb-2 w-[248px] -translate-x-1/2 rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[var(--bg-secondary)] p-4 text-[var(--text-primary)] shadow-[0_18px_48px_rgba(0,0,0,0.12)]">
          <MetricRow label="Model" value={resolvedModelLabel} mono />
          {snapshot ? (
            <>
              {snapshot.total > 0 && (
                <MetricRow label="Context Window" value={formatCompact(snapshot.total)} />
              )}
              <MetricRow label="Input Tokens" value={formatCompact(snapshot.inputTokens)} />
              <MetricRow label="Output Tokens" value={formatCompact(snapshot.outputTokens)} />

              <Divider />

              <MetricRow label="Cache Read" value={formatCompact(snapshot.cacheReadTokens)} />
              <MetricRow label="Cache Creation" value={formatCompact(snapshot.cacheCreationTokens)} />

              <div className="mt-4 border-t border-[var(--border)] pt-3 text-[12px] leading-5 text-[var(--text-secondary)]">
                Reported by the most recent Claude response
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

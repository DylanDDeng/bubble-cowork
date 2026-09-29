import type { SessionStreamingState } from '../types';

export function StreamRetryStatus({ retry }: { retry: NonNullable<SessionStreamingState['retry']> }) {
  const status = retry.errorStatus;
  const label = status === 429 ? 'Rate limited · Retrying'
    : status === 503 || status === 529 ? 'Server is busy · Retrying'
      : status == null ? 'Connection interrupted · Reconnecting' : `API error (${status}) · Retrying`;
  return (
    <div role="status" aria-live="polite" aria-atomic="true" data-stream-retry
      className="my-3 text-[13px] text-[var(--text-secondary)]">
      {label}{retry.maxRetries > 0 ? <span className="tabular-nums"> {retry.attempt}/{retry.maxRetries}</span> : null}
    </div>
  );
}

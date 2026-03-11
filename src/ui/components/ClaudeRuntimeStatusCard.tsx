import { AlertTriangle, CheckCircle2, Copy, RefreshCw, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import type { ClaudeRuntimeStatus } from '../types';

type ActionButton = {
  label: string;
  onClick: () => void;
};

function getTone(status: ClaudeRuntimeStatus, loading: boolean) {
  if (loading) {
    return {
      border: 'border-[var(--border)]',
      bg: 'bg-[var(--bg-secondary)]',
      badge: 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]',
      icon: <RefreshCw className="h-4 w-4 animate-spin text-[var(--text-secondary)]" />,
    };
  }

  if (status.kind === 'ready') {
    return {
      border: 'border-emerald-200/70',
      bg: 'bg-emerald-50/70',
      badge: 'bg-emerald-100 text-emerald-700',
      icon: <CheckCircle2 className="h-4 w-4 text-emerald-600" />,
    };
  }

  if (status.kind === 'login_required') {
    return {
      border: 'border-amber-200/80',
      bg: 'bg-amber-50/75',
      badge: 'bg-amber-100 text-amber-700',
      icon: <AlertTriangle className="h-4 w-4 text-amber-600" />,
    };
  }

  return {
    border: 'border-rose-200/80',
    bg: 'bg-rose-50/75',
    badge: 'bg-rose-100 text-rose-700',
    icon: <Wrench className="h-4 w-4 text-rose-600" />,
  };
}

async function copyCommand(command: string) {
  try {
    await navigator.clipboard.writeText(command);
    toast.success(`Copied: ${command}`);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Failed to copy command.');
  }
}

export function ClaudeRuntimeStatusCard({
  status,
  loading,
  compact = false,
  onRefresh,
  primaryAction,
}: {
  status: ClaudeRuntimeStatus;
  loading: boolean;
  compact?: boolean;
  onRefresh?: () => void;
  primaryAction?: ActionButton;
}) {
  const tone = getTone(status, loading);
  const commands = [status.installCommand, status.loginCommand, status.setupTokenCommand].filter(
    (value, index, items): value is string => Boolean(value) && items.indexOf(value) === index
  );

  return (
    <div
      className={`rounded-[22px] border ${tone.border} ${tone.bg} ${compact ? 'px-4 py-4' : 'px-5 py-5'} transition-colors`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {tone.icon}
            <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${tone.badge}`}>
              Claude Runtime
            </span>
          </div>
          <div className={`mt-3 font-semibold text-[var(--text-primary)] ${compact ? 'text-[14px]' : 'text-[15px]'}`}>
            {loading ? 'Checking Claude runtime…' : status.summary}
          </div>
          <div className={`mt-1.5 text-[var(--text-secondary)] ${compact ? 'text-[12px] leading-5' : 'text-[13px] leading-6'}`}>
            {loading ? 'Verifying CLI availability, version, and authentication state.' : status.detail}
          </div>
        </div>

        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
            title="Refresh Claude runtime status"
            aria-label="Refresh Claude runtime status"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        )}
      </div>

      {!loading && (
        <div className={`mt-4 grid gap-2 ${compact ? 'grid-cols-1' : 'sm:grid-cols-3'}`}>
          <MetaPill label="Version" value={status.cliVersion || 'Unknown'} />
          <MetaPill label="Auth" value={status.authMethod || (status.loggedIn ? 'account' : status.hasApiKey ? 'api_key' : 'none')} />
          <MetaPill label="Model mode" value={status.requiresAnthropicAuth ? 'Anthropic auth required' : 'Compatible provider model'} />
        </div>
      )}

      {!loading && commands.length > 0 && status.kind !== 'ready' && (
        <div className="mt-4 space-y-2">
          {commands.map((command) => (
            <button
              key={command}
              type="button"
              onClick={() => void copyCommand(command)}
              className="flex w-full items-center justify-between gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2.5 text-left transition-colors hover:border-[var(--text-muted)]"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--text-primary)]">{command}</span>
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--text-secondary)]">
                <Copy className="h-3.5 w-3.5" />
                Copy
              </span>
            </button>
          ))}
        </div>
      )}

      {primaryAction && (
        <div className="mt-4">
          <button
            type="button"
            onClick={primaryAction.onClick}
            className="inline-flex items-center rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)] transition-colors hover:border-[var(--text-muted)]"
          >
            {primaryAction.label}
          </button>
        </div>
      )}
    </div>
  );
}

function MetaPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">{label}</div>
      <div className="mt-1 truncate text-[12px] font-medium text-[var(--text-primary)]">{value}</div>
    </div>
  );
}

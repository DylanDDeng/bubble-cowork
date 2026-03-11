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
  const authValue = status.authMethod || (status.loggedIn ? 'account' : status.hasApiKey ? 'api_key' : 'none');
  const modelModeValue = status.requiresAnthropicAuth ? 'Anthropic auth required' : 'Compatible provider model';

  return (
    <div
      className={`rounded-[22px] border ${tone.border} ${tone.bg} ${
        compact ? 'px-4 py-3.5' : 'px-5 py-4.5'
      } transition-colors`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {tone.icon}
            <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${tone.badge}`}>
              Claude Runtime
            </span>
            <div className={`min-w-0 font-semibold text-[var(--text-primary)] ${compact ? 'text-[13px]' : 'text-[14px]'}`}>
              {loading ? 'Checking Claude runtime…' : status.summary}
            </div>
          </div>
          <div className={`mt-2 text-[var(--text-secondary)] ${compact ? 'text-[12px] leading-5' : 'text-[13px] leading-5'}`}>
            {loading ? 'Verifying CLI availability, version, and authentication state.' : status.detail}
          </div>
        </div>

        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            className={`inline-flex items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] ${
              compact ? 'h-8 w-8' : 'h-9 w-9'
            }`}
            title="Refresh Claude runtime status"
            aria-label="Refresh Claude runtime status"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        )}
      </div>

      {!loading && (
        <div className="mt-3 flex flex-wrap gap-2">
          <MetaPill compact={compact} label="Version" value={status.cliVersion || 'Unknown'} />
          <MetaPill compact={compact} label="Auth" value={authValue} />
          <MetaPill compact={compact} label="Model mode" value={modelModeValue} />
        </div>
      )}

      {!loading && commands.length > 0 && status.kind !== 'ready' && (
        <div className="mt-3 space-y-2">
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
        <div className="mt-3">
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

function MetaPill({
  label,
  value,
  compact,
}: {
  label: string;
  value: string;
  compact?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl border border-[var(--border)] bg-[var(--bg-primary)] ${
        compact ? 'px-2.5 py-2' : 'px-3 py-2.5'
      }`}
    >
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">{label}</div>
      <div className={`truncate font-medium text-[var(--text-primary)] ${compact ? 'mt-0.5 text-[11px]' : 'mt-1 text-[12px]'}`}>
        {value}
      </div>
    </div>
  );
}

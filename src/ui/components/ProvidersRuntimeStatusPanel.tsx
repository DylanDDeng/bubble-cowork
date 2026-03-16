import claudeLogo from '../assets/claude-color.svg';
import { AlertTriangle, Braces, CheckCircle2, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ClaudeRuntimeStatus, CodexRuntimeStatus } from '../types';

type Props = {
  claudeStatus: ClaudeRuntimeStatus;
  claudeLoading: boolean;
  codexStatus: CodexRuntimeStatus;
  codexLoading: boolean;
  onRefresh: () => void;
};

export function ProvidersRuntimeStatusPanel({
  claudeStatus,
  claudeLoading,
  codexStatus,
  codexLoading,
  onRefresh,
}: Props) {
  const [refreshPulse, setRefreshPulse] = useState(false);
  const refreshPulseTimerRef = useRef<number | null>(null);
  const showClaudeLoading = claudeLoading || refreshPulse;
  const showCodexLoading = codexLoading || refreshPulse;
  const busy = showClaudeLoading || showCodexLoading;

  useEffect(() => {
    return () => {
      if (refreshPulseTimerRef.current !== null) {
        window.clearTimeout(refreshPulseTimerRef.current);
      }
    };
  }, []);

  const handleRefresh = () => {
    if (refreshPulseTimerRef.current !== null) {
      window.clearTimeout(refreshPulseTimerRef.current);
    }

    setRefreshPulse(true);
    onRefresh();

    refreshPulseTimerRef.current = window.setTimeout(() => {
      setRefreshPulse(false);
      refreshPulseTimerRef.current = null;
    }, 650);
  };

  return (
    <section className="overflow-hidden rounded-[28px] border border-[var(--border)] bg-[var(--bg-secondary)] shadow-[0_22px_55px_rgba(15,23,42,0.06)]">
      <div className="border-b border-[var(--border)] px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
              Runtime Health
            </div>
            <div className="mt-2 text-[20px] font-semibold tracking-[-0.03em] text-[var(--text-primary)]">
              Agent Connectivity
            </div>
            <div className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
              Check whether Claude and Codex are ready before starting new sessions.
            </div>
          </div>

          <button
            type="button"
            onClick={handleRefresh}
            className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-secondary)] transition-colors hover:border-[var(--text-muted)] hover:text-[var(--text-primary)]"
            aria-label="Refresh runtime status"
            title="Refresh runtime status"
          >
            <RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <div className="grid gap-3 p-3 md:grid-cols-2">
        <RuntimeCard
          runtimeLabel="Claude Runtime"
          loading={showClaudeLoading}
          connected={claudeStatus.ready}
          summary={showClaudeLoading ? 'Checking Claude runtime…' : claudeStatus.summary}
          detail={
            showClaudeLoading
              ? 'Verifying CLI availability and authentication state.'
              : claudeStatus.detail
          }
          icon={
            <img
              src={claudeLogo}
              alt=""
              className="h-[18px] w-[18px]"
              aria-hidden="true"
            />
          }
          meta={
            showClaudeLoading
              ? []
              : [
                  { label: 'Version', value: claudeStatus.cliVersion || 'Unknown' },
                  {
                    label: 'Auth',
                    value:
                      claudeStatus.authMethod ||
                      (claudeStatus.loggedIn
                        ? 'account'
                        : claudeStatus.hasApiKey
                          ? 'api_key'
                          : 'none'),
                  },
                ]
          }
        />

        <RuntimeCard
          runtimeLabel="Codex Runtime"
          loading={showCodexLoading}
          connected={codexStatus.ready}
          summary={buildCodexSummary(codexStatus, showCodexLoading)}
          detail={buildCodexDetail(codexStatus, showCodexLoading)}
          icon={<Braces className="h-[18px] w-[18px] text-[var(--text-primary)]" strokeWidth={2} />}
          meta={
            showCodexLoading
              ? []
              : [
                  { label: 'CLI', value: codexStatus.cliAvailable ? 'Detected' : 'Missing' },
                  { label: 'Config', value: codexStatus.configExists ? 'Found' : 'Not found' },
                  { label: 'Models', value: codexStatus.hasModelConfig ? 'Ready' : 'Empty' },
                ]
          }
        />
      </div>
    </section>
  );
}

function RuntimeCard({
  runtimeLabel,
  loading,
  connected,
  summary,
  detail,
  icon,
  meta,
}: {
  runtimeLabel: string;
  loading: boolean;
  connected: boolean;
  summary: string;
  detail: string;
  icon: ReactNode;
  meta: Array<{ label: string; value: string }>;
}) {
  const tone = loading
    ? {
        shell: 'border-[var(--border)] bg-[var(--bg-primary)]',
        iconBg: 'bg-[var(--bg-tertiary)]',
        badge: 'border-[var(--border)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]',
        accent: <RefreshCw className="h-4 w-4 animate-spin text-[var(--text-secondary)]" />,
      }
    : connected
      ? {
          shell: 'border-emerald-200/80 bg-[linear-gradient(180deg,rgba(16,185,129,0.08),rgba(255,255,255,0.92))]',
          iconBg: 'bg-emerald-100/80',
          badge: 'border-emerald-200/80 bg-emerald-50 text-emerald-700',
          accent: <CheckCircle2 className="h-4 w-4 text-emerald-600" />,
        }
      : {
          shell: 'border-amber-200/80 bg-[linear-gradient(180deg,rgba(245,158,11,0.08),rgba(255,255,255,0.92))]',
          iconBg: 'bg-amber-100/80',
          badge: 'border-amber-200/80 bg-amber-50 text-amber-700',
          accent: <AlertTriangle className="h-4 w-4 text-amber-600" />,
        };

  return (
    <div className={`rounded-[24px] border p-4 shadow-sm transition-colors ${tone.shell}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className={`flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[16px] ${tone.iconBg}`}>
            {icon}
          </div>

          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
              {runtimeLabel}
            </div>
            <div className="mt-2 text-[16px] font-semibold tracking-[-0.02em] text-[var(--text-primary)]">
              {summary}
            </div>
          </div>
        </div>

        <div className="flex flex-shrink-0 items-center gap-2">
          {tone.accent}
          <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${tone.badge}`}>
            {loading ? 'Checking' : connected ? 'Connected' : 'Disconnect'}
          </span>
        </div>
      </div>

      <div className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">{detail}</div>

      {meta.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {meta.map((item) => (
            <div
              key={`${runtimeLabel}-${item.label}`}
              className="rounded-2xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 shadow-[0_1px_2px_rgba(15,23,42,0.03)]"
            >
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
                {item.label}
              </div>
              <div className="mt-1 text-[12px] font-medium text-[var(--text-primary)]">
                {item.value}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function buildCodexSummary(status: CodexRuntimeStatus, loading: boolean): string {
  if (loading) {
    return 'Checking Codex runtime…';
  }

  if (status.ready) {
    return 'Codex ACP is ready.';
  }

  if (!status.cliAvailable) {
    return 'Codex ACP was not found.';
  }

  return 'Codex needs local setup.';
}

function buildCodexDetail(status: CodexRuntimeStatus, loading: boolean): string {
  if (loading) {
    return 'Verifying the local ACP command and Codex configuration files.';
  }

  if (status.ready) {
    return 'Codex sessions can start with the local ACP runtime and saved model configuration.';
  }

  if (!status.cliAvailable) {
    return 'Aegis could not find `codex-acp` on PATH. Install the Codex runtime first, then refresh this panel.';
  }

  if (!status.configExists && !status.hasModelConfig) {
    return 'The runtime exists, but no local Codex config or model cache was detected yet.';
  }

  return 'The runtime exists, but the local Codex setup is still incomplete.';
}

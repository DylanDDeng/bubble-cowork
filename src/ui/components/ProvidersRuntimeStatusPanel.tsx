import claudeLogo from '../assets/claude-color.svg';
import openaiLogo from '../assets/openai.svg';
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Badge } from './ui/badge';
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
    <section className="overflow-hidden rounded-[20px] border border-[var(--border)] bg-[var(--bg-secondary)] shadow-[0_22px_55px_rgba(15,23,42,0.06)]">
      <div className="border-b border-[var(--border)] px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
              Agent
            </div>
            <div className="mt-2 text-lg font-semibold text-[var(--text-primary)]">
              Connectivity
            </div>
            <div className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
              Check whether Claude and Codex are available for new sessions.
            </div>
          </div>

          <button
            type="button"
            onClick={handleRefresh}
            className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-secondary)] transition-colors hover:border-[var(--text-muted)] hover:text-[var(--text-primary)]"
            aria-label="Refresh runtime status"
            title="Refresh runtime status"
          >
            <RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <div className="space-y-2.5 p-3">
        <RuntimeRow
          loading={showClaudeLoading}
          connected={claudeStatus.ready}
          summary={showClaudeLoading ? 'Checking Claude runtime…' : claudeStatus.summary}
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

        <RuntimeRow
          loading={showCodexLoading}
          connected={codexStatus.ready}
          summary={buildCodexSummary(codexStatus, showCodexLoading)}
          icon={
            <img
              src={openaiLogo}
              alt=""
              className="h-[18px] w-[18px]"
              aria-hidden="true"
            />
          }
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

function RuntimeRow({
  loading,
  connected,
  summary,
  icon,
  meta,
}: {
  loading: boolean;
  connected: boolean;
  summary: string;
  icon: ReactNode;
  meta: Array<{ label: string; value: string }>;
}) {
  const tone = loading
    ? {
        shell: 'border-[var(--border)] bg-[var(--bg-primary)]',
        accent: <RefreshCw className="h-4 w-4 animate-spin text-[var(--text-secondary)]" />,
        status: 'text-[var(--text-secondary)]',
      }
    : connected
      ? {
        shell: 'border-[var(--border)] bg-[var(--bg-primary)]',
        accent: <CheckCircle2 className="h-4 w-4 text-[var(--text-secondary)]" />,
        status: 'text-emerald-700',
      }
    : {
        shell: 'border-[var(--border)] bg-[var(--bg-primary)]',
        accent: <AlertTriangle className="h-4 w-4 text-[var(--text-secondary)]" />,
        status: 'text-[#dc2626]',
      };

  return (
    <div className={`rounded-[16px] border px-4 py-2.5 shadow-sm transition-colors ${tone.shell}`}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex flex-1 items-center gap-3">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center">
            {icon}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-[15px] font-semibold tracking-[-0.02em] text-[var(--text-primary)] leading-6">
                {summary}
              </div>

              {meta.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {meta.map((item) => (
                    <Badge
                      key={`${item.label}-${item.value}`}
                      variant="outline"
                      className="gap-1.5 border-[var(--border)] bg-[var(--bg-primary)] px-2 py-0.5 text-[10px] font-medium shadow-[0_1px_2px_rgba(15,23,42,0.03)]"
                    >
                      <span className="font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
                        {item.label}
                      </span>
                      <span className="text-[var(--text-primary)]">{item.value}</span>
                    </Badge>
                  ))}
                </div>
              )}
            </div>

          </div>
        </div>

        <div className="flex flex-shrink-0 items-center gap-2">
          {tone.accent}
          <span className="text-[var(--text-muted)]">|</span>
          <span className={`text-[12px] font-semibold ${tone.status}`}>
            {loading ? 'Checking' : connected ? 'Connected' : 'Disconnect'}
          </span>
        </div>
      </div>
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

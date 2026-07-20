import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import claudeLogo from '../../assets/claude-color.svg';
import grokLogo from '../../assets/grok.svg';
import moonshotLogo from '../../assets/moonshot.svg';
import openaiLogo from '../../assets/openai.svg';
import piLogo from '../../assets/pi-logo-auto.svg';
import qoderLogo from '../../assets/qoder.svg';
import { OpenCodeLogo } from '../OpenCodeLogo';
import { Check, Copy, ExternalLink, Loader2, RefreshCw } from '../icons';
import type { AgentProvider, AgentRuntimeDirectoryReport, AgentRuntimeEntry } from '../../../shared/types';
import { rendererStateStorage } from '../../utils/renderer-state-storage';

const ONBOARDING_DONE_KEY = 'aegis-onboarding-complete';

const PROVIDER_LOGOS: Record<AgentProvider, ReactNode> = {
  claude: <img src={claudeLogo} alt="" className="h-5 w-5" aria-hidden="true" />,
  codex: <img src={openaiLogo} alt="" className="h-5 w-5" aria-hidden="true" />,
  opencode: <OpenCodeLogo className="h-5 w-5" />,
  kimi: <img src={moonshotLogo} alt="" className="h-5 w-5" aria-hidden="true" />,
  grok: <img src={grokLogo} alt="" className="h-5 w-5" aria-hidden="true" />,
  pi: <img src={piLogo} alt="" className="h-5 w-5" aria-hidden="true" />,
  qoder: <img src={qoderLogo} alt="" className="h-5 w-5" aria-hidden="true" />,
};

/**
 * Gate for the first-run agent detection page. Shows on first launch (no
 * dismissal flag yet) and again whenever a later launch detects zero ready
 * agents — the main UI is unusable in that state.
 */
export function useAgentOnboardingGate(enabled: boolean): {
  visible: boolean;
  dismiss: () => void;
} {
  const [visible, setVisible] = useState<boolean>(() => {
    try {
      return !rendererStateStorage.getItem(ONBOARDING_DONE_KEY);
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (!enabled || visible) return;
    let cancelled = false;
    window.electron
      .getAgentRuntimeDirectory()
      .then((report) => {
        if (!cancelled && report.readyCount === 0) {
          setVisible(true);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // Run once per app launch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const dismiss = useCallback(() => {
    try {
      rendererStateStorage.setItem(ONBOARDING_DONE_KEY, String(Date.now()));
    } catch {
      // storage unavailable — still dismiss for this run
    }
    setVisible(false);
  }, []);

  return { visible, dismiss };
}

export function AgentOnboardingView({ onComplete }: { onComplete: () => void }) {
  const [report, setReport] = useState<AgentRuntimeDirectoryReport | null>(null);
  const [checking, setChecking] = useState(true);

  const detect = useCallback(async (force: boolean) => {
    setChecking(true);
    try {
      const next = await window.electron.getAgentRuntimeDirectory(force);
      setReport(next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Detection failed.');
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void detect(false);
  }, [detect]);

  const readyCount = report?.readyCount ?? 0;
  const canStart = readyCount > 0;

  return (
    <div className="flex h-full flex-col items-center overflow-y-auto bg-[var(--bg-primary)] px-6 py-12">
      <div className="w-full max-w-[560px]">
        <div className="text-center">
          <div className="text-[24px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
            Connect your coding agents
          </div>
          <p className="mx-auto mt-2 max-w-[420px] text-[13px] leading-6 text-[var(--text-muted)]">
            Aegis drives the AI coding agents installed on this machine. Install and sign in to at
            least one, then start working — you can add more at any time.
          </p>
        </div>

        <div className="mt-8 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_1px_2px_rgba(15,23,42,0.05)]">
          <div className="divide-y divide-[var(--border)]">
            {report
              ? report.entries.map((item) => <AgentRuntimeRow key={item.provider} entry={item} />)
              : Array.from({ length: 6 }, (_, index) => <AgentRuntimeRowSkeleton key={index} />)}
          </div>
        </div>

        <div className="mt-6 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => void detect(true)}
            disabled={checking}
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-3.5 text-[12.5px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
          >
            {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Re-detect
          </button>

          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={onComplete}
              className="text-[12px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
            >
              Skip for now
            </button>
            <button
              type="button"
              onClick={onComplete}
              disabled={!canStart}
              title={canStart ? undefined : 'Install and sign in to at least one agent first.'}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-4 text-[12.5px] font-semibold text-[var(--accent-foreground)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Get started
              <span aria-hidden="true">→</span>
            </button>
          </div>
        </div>

        {!checking && !canStart ? (
          <p className="mt-4 text-center text-[12px] text-[var(--text-muted)]">
            No agent is ready yet. Install one with the commands above, then hit Re-detect.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function StateChip({ entry }: { entry: AgentRuntimeEntry }) {
  if (entry.state === 'ready') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
        <Check className="h-3 w-3" />
        Ready
      </span>
    );
  }
  if (entry.state === 'login_required') {
    return (
      <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
        Sign in required
      </span>
    );
  }
  if (entry.state === 'not_installed') {
    return (
      <span className="inline-flex items-center rounded-full bg-[var(--bg-tertiary)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-muted)]">
        Not installed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-[var(--bg-tertiary)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-muted)]">
      Check failed
    </span>
  );
}

function CommandPill({ command, ariaLabel }: { command: string; ariaLabel: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      toast.success('Command copied.');
    } catch {
      toast.error('Failed to copy.');
    }
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={ariaLabel}
      title="Copy command"
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 font-mono text-[11px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--text-primary)]"
    >
      <span className="truncate">{command}</span>
      <Copy className="h-3 w-3 shrink-0" />
    </button>
  );
}

export function AgentRuntimeRow({ entry }: { entry: AgentRuntimeEntry }) {
  const showInstall = entry.state === 'not_installed';
  const showLogin = entry.state === 'login_required';

  return (
    <div className="flex items-start gap-3 px-4 py-3.5">
      <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg-primary)]">
        {PROVIDER_LOGOS[entry.provider]}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13.5px] font-semibold text-[var(--text-primary)]">{entry.title}</span>
          {entry.version ? (
            <span className="text-[11px] text-[var(--text-muted)]">v{entry.version}</span>
          ) : null}
          <StateChip entry={entry} />
        </div>
        {entry.state !== 'ready' ? (
          <div className="mt-1 text-[12px] leading-5 text-[var(--text-muted)]">
            {entry.summary}
            {entry.detail && entry.detail !== entry.summary ? ` ${entry.detail}` : ''}
          </div>
        ) : null}
        {(showInstall && entry.installCommand) || (showLogin && entry.loginCommand) || entry.docsUrl ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {showInstall && entry.installCommand ? (
              <CommandPill command={entry.installCommand} ariaLabel={`Copy ${entry.title} install command`} />
            ) : null}
            {showLogin && entry.loginCommand ? (
              <CommandPill command={entry.loginCommand} ariaLabel={`Copy ${entry.title} login command`} />
            ) : null}
            {entry.docsUrl && entry.state !== 'ready' ? (
              <button
                type="button"
                onClick={() => void window.electron.openExternalUrl(entry.docsUrl!)}
                className="inline-flex items-center gap-1 text-[11.5px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
              >
                Docs
                <ExternalLink className="h-3 w-3" />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AgentRuntimeRowSkeleton() {
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <div className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-[var(--bg-tertiary)]" />
      <div className="flex-1 space-y-2">
        <div className="h-3.5 w-32 animate-pulse rounded bg-[var(--bg-tertiary)]" />
        <div className="h-3 w-56 animate-pulse rounded bg-[var(--bg-tertiary)]" />
      </div>
    </div>
  );
}

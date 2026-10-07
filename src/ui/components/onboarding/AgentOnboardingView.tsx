import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import claudeLogo from '../../assets/claude-color.svg';
import grokLogo from '../../assets/grok.svg';
import moonshotLogo from '../../assets/moonshot.svg';
import openaiLogo from '../../assets/openai.svg';
import piLogo from '../../assets/pi-logo-auto.svg';
import bubbleLogo from '../../assets/bubble-logo-auto.svg';
import qoderLogo from '../../assets/qoder.svg';
import devinLogo from '../../assets/devin-color.svg';
import { OpenCodeLogo } from '../OpenCodeLogo';
import { DeepseekLogo } from '../DeepseekLogo';
import { MimoLogo } from '../MimoLogo';
import { ArrowLeft, Check, ChevronDown, ExternalLink, Eye, EyeOff, Loader2, Search } from '../icons';
import type {
  AgentProvider,
  AgentRuntimeDirectoryReport,
  AgentRuntimeEntry,
  AgentRuntimeInstallResult,
  BubbleProviderSummary,
} from '../../../shared/types';
import { rendererStateStorage } from '../../utils/renderer-state-storage';
import { useBrowserNativeOverlayRegistration } from '../browser/browser-native-overlay';
import { BubbleProviderLogo } from '../settings/BubbleProviderSettings';
import * as DropdownMenu from '../ui/dropdown-menu';
import { announcePreferredProvider, loadPreferredProvider } from '../../utils/provider';

const ONBOARDING_DONE_KEY = 'aegis-onboarding-complete';

// Always listed first: the default we point new users at.
const FIRST_PROVIDER: AgentProvider = 'claude';
const NODE_DOWNLOAD_URL = 'https://nodejs.org/';

// Logos render bare (no avatar circle) so the list reads as one flat column.
function ProviderLogo({ provider, className }: { provider: AgentProvider; className: string }) {
  switch (provider) {
    case 'opencode':
      return <OpenCodeLogo className={className} />;
    case 'deepseek':
      return <DeepseekLogo className={className} />;
    case 'mimo':
      return <MimoLogo className={className} />;
    default:
      return (
        <img
          src={PROVIDER_LOGO_SRC[provider]}
          alt=""
          className={`${className} ${MONOCHROME_PROVIDERS.has(provider) ? 'provider-monochrome-logo' : ''}`}
          aria-hidden="true"
        />
      );
  }
}

const PROVIDER_LOGO_SRC: Record<Exclude<AgentProvider, 'opencode' | 'deepseek' | 'mimo'>, string> = {
  claude: claudeLogo,
  codex: openaiLogo,
  kimi: moonshotLogo,
  grok: grokLogo,
  pi: piLogo,
  qoder: qoderLogo,
  bubble: bubbleLogo,
  devin: devinLogo,
};

// Black single-colour marks that need inverting on dark surfaces.
const MONOCHROME_PROVIDERS = new Set<AgentProvider>(['claude', 'codex', 'grok', 'kimi']);

const STATE_ORDER: Record<AgentRuntimeEntry['state'], number> = {
  ready: 0,
  login_required: 1,
  error: 2,
  not_installed: 3,
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

type InstallFailure = Extract<AgentRuntimeInstallResult, { ok: false }>;

type OnboardingView = 'overview' | 'all' | 'bubble-provider' | 'bubble-key';

// Bubble ships inside Aegis, so it is the agent a new user can always start
// with: pick the provider their API key comes from, paste the key, done.
const BUILT_IN_PROVIDER: AgentProvider = 'bubble';

function byDisplayOrder(a: AgentRuntimeEntry, b: AgentRuntimeEntry): number {
  if (a.provider === FIRST_PROVIDER) return -1;
  if (b.provider === FIRST_PROVIDER) return 1;
  return STATE_ORDER[a.state] - STATE_ORDER[b.state];
}

/** A step the user can take right here, without leaving the panel. */
function needsSetupInPanel(entry: AgentRuntimeEntry): boolean {
  if (entry.provider === BUILT_IN_PROVIDER) return entry.state === 'login_required';
  if (entry.state === 'not_installed') return entry.canAutoInstall;
  return entry.state === 'login_required' && entry.loginCommand !== null;
}

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(target.tagName) || target.isContentEditable)
  );
}

export function AgentOnboardingView({ onComplete }: { onComplete: () => void }) {
  const [report, setReport] = useState<AgentRuntimeDirectoryReport | null>(null);
  const [checking, setChecking] = useState(true);
  const [installing, setInstalling] = useState<Partial<Record<AgentProvider, boolean>>>({});
  const [installErrors, setInstallErrors] = useState<Partial<Record<AgentProvider, InstallFailure>>>({});
  const [notFoundAfterInstall, setNotFoundAfterInstall] = useState<Partial<Record<AgentProvider, boolean>>>({});
  const [signInOpen, setSignInOpen] = useState<Partial<Record<AgentProvider, boolean>>>({});
  const [view, setView] = useState<OnboardingView | null>(null);
  // Where Back from the Bubble steps or the full list returns to.
  const [returnView, setReturnView] = useState<OnboardingView | null>(null);
  const [bubbleProvider, setBubbleProvider] = useState<BubbleProviderSummary | null>(null);
  const [defaultAgent, setDefaultAgent] = useState<AgentProvider | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Restored browser panes are native views that paint above the DOM; detach
  // them while the panel is up (the gate also shows for returning users).
  useBrowserNativeOverlayRegistration(true);

  // The composer behind autofocuses (after this mounts, too). Keep focus in
  // the panel so typing and Tab never land in the covered workspace.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.focus();
    const reclaim = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || dialog.contains(target)) return;
      // Menus opened from the panel render in a portal outside it.
      if (target.closest('[role="menu"]')) return;
      dialog.focus();
    };
    document.addEventListener('focusin', reclaim);
    return () => document.removeEventListener('focusin', reclaim);
  }, []);

  const detect = useCallback(async (force: boolean): Promise<AgentRuntimeDirectoryReport | null> => {
    setChecking(true);
    try {
      const next = await window.electron.getAgentRuntimeDirectory(force);
      setReport(next);
      return next;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Detection failed.');
      return null;
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void detect(false);
  }, [detect]);

  // Sign-in and manual installs happen in Terminal; re-check when the user
  // comes back to Aegis so the panel updates without a button press.
  const checkingRef = useRef(false);
  checkingRef.current = checking;
  useEffect(() => {
    const onFocus = () => {
      if (!checkingRef.current) void detect(true);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [detect]);

  const entries = useMemo(() => [...(report?.entries ?? [])].sort(byDisplayOrder), [report]);
  const ready = useMemo(() => entries.filter((item) => item.state === 'ready'), [entries]);
  const needsSetup = useMemo(() => entries.filter(needsSetupInPanel), [entries]);
  const bubbleEntry = entries.find((item) => item.provider === BUILT_IN_PROVIDER) ?? null;

  // First report decides the opening view: with nothing ready, go straight to
  // the built-in agent; otherwise summarise what's already there.
  useEffect(() => {
    if (!report || view !== null) return;
    const canStartWithBubble = bubbleEntry?.state === 'login_required';
    setView(report.readyCount === 0 && canStartWithBubble ? 'bubble-provider' : 'overview');
  }, [bubbleEntry, report, view]);

  // Default agent: keep the saved preference when it works, else the first ready one.
  useEffect(() => {
    if (ready.length === 0) return;
    setDefaultAgent((current) => {
      if (current && ready.some((item) => item.provider === current)) return current;
      const preferred = loadPreferredProvider();
      return ready.some((item) => item.provider === preferred) ? preferred : ready[0].provider;
    });
  }, [ready]);

  const finish = useCallback(
    (provider: AgentProvider | null) => {
      if (provider) announcePreferredProvider(provider);
      onComplete();
    },
    [onComplete]
  );

  const install = useCallback(
    async (entry: AgentRuntimeEntry) => {
      setInstalling((prev) => ({ ...prev, [entry.provider]: true }));
      setInstallErrors((prev) => ({ ...prev, [entry.provider]: undefined }));
      setNotFoundAfterInstall((prev) => ({ ...prev, [entry.provider]: false }));
      try {
        const result = await window.electron.installAgentRuntime(entry.provider);
        if (result.ok) {
          // A fresh install almost always needs sign-in next; open that step.
          setSignInOpen((prev) => ({ ...prev, [entry.provider]: true }));
          const next = await detect(true);
          // npm succeeded but the CLI still isn't found: usually npm's global
          // bin folder is missing from PATH. Say so instead of offering
          // Install again as if nothing happened.
          const after = next?.entries.find((item) => item.provider === entry.provider);
          if (after?.state === 'not_installed') {
            setNotFoundAfterInstall((prev) => ({ ...prev, [entry.provider]: true }));
          }
        } else {
          setInstallErrors((prev) => ({ ...prev, [entry.provider]: result }));
        }
      } catch (error) {
        setInstallErrors((prev) => ({
          ...prev,
          [entry.provider]: {
            ok: false,
            reason: 'failed',
            message: error instanceof Error ? error.message : 'The install failed.',
          },
        }));
      } finally {
        setInstalling((prev) => ({ ...prev, [entry.provider]: false }));
      }
    },
    [detect]
  );

  const openBubbleSetup = useCallback((from: OnboardingView) => {
    setReturnView(from);
    setView('bubble-provider');
  }, []);

  const rowProps = (entry: AgentRuntimeEntry, from: OnboardingView) => ({
    entry,
    installing: installing[entry.provider] === true,
    installError: installErrors[entry.provider] ?? null,
    notFoundAfterInstall: notFoundAfterInstall[entry.provider] === true,
    signInOpen: signInOpen[entry.provider] === true,
    onInstall: () => void install(entry),
    onToggleSignIn: () =>
      setSignInOpen((prev) => ({ ...prev, [entry.provider]: !prev[entry.provider] })),
    onAddKey: entry.provider === BUILT_IN_PROVIDER ? () => openBubbleSetup(from) : undefined,
  });

  const handleKeyDown = (event: React.KeyboardEvent) => {
    // App shortcuts listen on window; keep them from acting on the
    // workspace hidden behind the panel.
    event.stopPropagation();
    if (event.key === 'Enter' && view === 'overview' && ready.length > 0 && !isTypingTarget(event.target)) {
      event.preventDefault();
      finish(defaultAgent);
    }
  };

  return (
    <div className="agent-onboarding fixed inset-0 z-[80] flex items-center justify-center bg-black/[0.1] px-4 dark:bg-black/40">
      <div className="drag-region absolute inset-x-0 top-0 h-9" aria-hidden="true" />
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-onboarding-title"
        onKeyDown={handleKeyDown}
        className="relative flex max-h-[calc(100vh-64px)] w-full max-w-[400px] flex-col overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_16px_40px_rgba(0,0,0,0.08),0_2px_6px_rgba(0,0,0,0.04)] outline-none"
      >
        {view === null ? (
          <div className="px-7 py-7">
            {Array.from({ length: 3 }, (_, index) => (
              <AgentRowSkeleton key={index} />
            ))}
          </div>
        ) : view === 'overview' ? (
          <OverviewStep
            ready={ready}
            needsSetup={needsSetup}
            defaultAgent={defaultAgent}
            onDefaultAgentChange={setDefaultAgent}
            renderRow={(entry) => <AgentRow key={entry.provider} {...rowProps(entry, 'overview')} compact />}
            onShowAll={() => {
              setReturnView('overview');
              setView('all');
            }}
            onGetStarted={() => finish(defaultAgent)}
            onLater={() => finish(null)}
          />
        ) : view === 'all' ? (
          <AllAgentsStep
            entries={entries}
            checking={checking}
            renderRow={(entry) => <AgentRow key={entry.provider} {...rowProps(entry, 'all')} />}
            onBack={() => setView(returnView ?? 'overview')}
            onCheckAgain={() => void detect(true)}
          />
        ) : view === 'bubble-provider' ? (
          <BubbleProviderStep
            onBack={returnView ? () => setView(returnView) : null}
            onPick={(provider) => {
              setBubbleProvider(provider);
              setView('bubble-key');
            }}
            onUseAnotherAgent={() => {
              setReturnView('bubble-provider');
              setView('all');
            }}
            onLater={() => finish(null)}
          />
        ) : bubbleProvider ? (
          <BubbleKeyStep
            provider={bubbleProvider}
            onBack={() => setView('bubble-provider')}
            onSaved={async () => {
              const next = await detect(true);
              const bubbleReady =
                next?.entries.find((item) => item.provider === BUILT_IN_PROVIDER)?.state === 'ready';
              if (bubbleReady) finish(BUILT_IN_PROVIDER);
              return bubbleReady;
            }}
            onUseAnotherAgent={() => {
              setReturnView('bubble-key');
              setView('all');
            }}
            onLater={() => finish(null)}
          />
        ) : null}
      </div>
    </div>
  );
}

const PRIMARY_BUTTON =
  'inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--text-primary)] text-[13px] font-medium text-[var(--bg-primary)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50';
const QUIET_LINK = 'text-[12px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]';

function EnterHint() {
  return (
    <span
      aria-hidden="true"
      className="rounded border border-current px-[5px] text-[11px] leading-4 opacity-50"
    >
      ↵
    </span>
  );
}

function LogoTile({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <span
      title={label}
      className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg border border-[var(--border)]"
    >
      {children}
      <span className="sr-only">{label}</span>
    </span>
  );
}

function StepHeader({ title, subtitle, children }: { title: string; subtitle: string; children?: React.ReactNode }) {
  return (
    <>
      {children}
      <h1 id="agent-onboarding-title" className="mt-5 text-[16px] font-semibold text-[var(--text-primary)]">
        {title}
      </h1>
      <p className="mt-1 text-[13px] leading-5 text-[var(--text-secondary)]">{subtitle}</p>
    </>
  );
}

function StepFooter({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
  return (
    <div className="mt-5 flex items-center gap-2 border-t border-[var(--border)] pt-4">
      {left}
      <div className="flex-1" />
      {right}
    </div>
  );
}

function OverviewStep({
  ready,
  needsSetup,
  defaultAgent,
  onDefaultAgentChange,
  renderRow,
  onShowAll,
  onGetStarted,
  onLater,
}: {
  ready: AgentRuntimeEntry[];
  needsSetup: AgentRuntimeEntry[];
  defaultAgent: AgentProvider | null;
  onDefaultAgentChange: (provider: AgentProvider) => void;
  renderRow: (entry: AgentRuntimeEntry) => React.ReactNode;
  onShowAll: () => void;
  onGetStarted: () => void;
  onLater: () => void;
}) {
  const hasReady = ready.length > 0;
  return (
    <div className="min-h-0 overflow-y-auto px-7 pb-6 pt-7">
      <StepHeader
        title={
          hasReady ? `${ready.length} ${ready.length === 1 ? 'agent' : 'agents'} ready` : 'Set up an agent'
        }
        subtitle={hasReady ? 'You can switch agents in any session.' : 'Finish one of these to start.'}
      >
        {hasReady ? (
          <div className="flex flex-wrap gap-1.5" data-ready-agents>
            {ready.map((item) => (
              <LogoTile key={item.provider} label={item.title}>
                <ProviderLogo provider={item.provider} className="h-[15px] w-[15px]" />
              </LogoTile>
            ))}
          </div>
        ) : null}
      </StepHeader>

      {needsSetup.length > 0 ? (
        <div className="mt-5">
          <div className="text-[12px] text-[var(--text-muted)]">Needs setup</div>
          <div className="mt-1" data-needs-setup>
            {needsSetup.map(renderRow)}
          </div>
        </div>
      ) : null}

      {ready.length > 1 ? (
        <div className="mt-5 flex items-center justify-between border-t border-[var(--border)] pt-4">
          <span id="agent-onboarding-default-label" className="text-[13px] text-[var(--text-secondary)]">
            Default agent
          </span>
<DefaultAgentPicker ready={ready} value={defaultAgent} onChange={onDefaultAgentChange} />
        </div>
      ) : null}

      {hasReady && needsSetup.length === 0 ? (
        // Everything is set up: nothing to review, one full-width action.
        <button type="button" onClick={onGetStarted} className={`${PRIMARY_BUTTON} mt-6 h-9 w-full`}>
          Get started
        </button>
      ) : (
        <StepFooter
          left={
            <button type="button" onClick={onShowAll} className={QUIET_LINK}>
              All agents
            </button>
          }
          right={
            hasReady ? (
              <button type="button" onClick={onGetStarted} className={`${PRIMARY_BUTTON} h-8 px-3`}>
                Get started
              </button>
            ) : (
              <button type="button" onClick={onLater} className={QUIET_LINK}>
                Later
              </button>
            )
          }
        />
      )}
    </div>
  );
}

function DefaultAgentPicker({
  ready,
  value,
  onChange,
}: {
  ready: AgentRuntimeEntry[];
  value: AgentProvider | null;
  onChange: (provider: AgentProvider) => void;
}) {
  const selected = ready.find((item) => item.provider === value) ?? ready[0];
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          id="agent-onboarding-default"
          aria-labelledby="agent-onboarding-default-label agent-onboarding-default"
          data-default-agent={selected?.provider}
          className="inline-flex h-[30px] min-w-0 items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] pl-2.5 pr-2 text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-secondary)]"
        >
          {selected ? <ProviderLogo provider={selected.provider} className="h-[13px] w-[13px] shrink-0" /> : null}
          <span className="truncate">{selected?.title}</span>
          <ChevronDown aria-hidden="true" className="h-3 w-3 shrink-0 text-[var(--text-muted)]" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          aria-label="Default agent"
          // Same scope as the panel so dark mode inverts the monochrome marks.
          className="agent-onboarding w-[200px] p-1"
        >
          <div className="max-h-72 overflow-y-auto overscroll-contain">
            {ready.map((item) => (
              <DropdownMenu.Item
                key={item.provider}
                data-default-agent-option={item.provider}
                onSelect={() => onChange(item.provider)}
                className="h-7 gap-2 rounded-md px-2 py-0 text-[13px] text-[var(--text-primary)] data-[highlighted]:bg-[var(--sidebar-item-hover)]"
              >
                <ProviderLogo provider={item.provider} className="h-[13px] w-[13px] shrink-0" />
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                {item.provider === selected?.provider ? (
                  <Check aria-label="Selected" className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
                ) : null}
              </DropdownMenu.Item>
            ))}
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function AllAgentsStep({
  entries,
  checking,
  renderRow,
  onBack,
  onCheckAgain,
}: {
  entries: AgentRuntimeEntry[];
  checking: boolean;
  renderRow: (entry: AgentRuntimeEntry) => React.ReactNode;
  onBack: () => void;
  onCheckAgain: () => void;
}) {
  return (
    <>
      <div className="flex items-center gap-2 px-5 pb-3 pt-5">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)]"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <h1 id="agent-onboarding-title" className="text-[15px] font-semibold text-[var(--text-primary)]">
          All agents
        </h1>
      </div>
      <div className="min-h-0 flex-1 divide-y divide-[var(--border)] overflow-y-auto border-t border-[var(--border)]">
        {entries.map(renderRow)}
      </div>
      <div className="flex items-center border-t border-[var(--border)] px-5 py-3">
        <button type="button" onClick={onCheckAgain} disabled={checking} className={`${QUIET_LINK} inline-flex h-7 items-center gap-1.5`}>
          {checking ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {checking ? 'Checking…' : 'Check again'}
        </button>
      </div>
    </>
  );
}

function BubbleProviderStep({
  onBack,
  onPick,
  onUseAnotherAgent,
  onLater,
}: {
  onBack: (() => void) | null;
  onPick: (provider: BubbleProviderSummary) => void;
  onUseAnotherAgent: () => void;
  onLater: () => void;
}) {
  const [providers, setProviders] = useState<BubbleProviderSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    window.electron
      .getBubbleProvidersConfig()
      .then((config) => {
        if (!cancelled) setProviders(config.providers);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : 'Could not load providers.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const all = providers ?? [];
    return needle
      ? all.filter((item) => item.name.toLowerCase().includes(needle) || item.id.includes(needle))
      : all;
  }, [providers, query]);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-provider-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, matches.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter' && matches[active]) {
      event.preventDefault();
      onPick(matches[active]);
    }
  };

  return (
    <div className="flex min-h-0 flex-col px-7 pb-5 pt-7">
      <StepHeader title="Start with Bubble" subtitle="Where's your API key from?">
        <div className="flex items-center justify-between">
          {onBack ? (
            <BackTile onClick={onBack} label="Back" />
          ) : (
            <LogoTile label="Bubble">
              <ProviderLogo provider="bubble" className="h-[15px] w-[15px]" />
            </LogoTile>
          )}
          <span className="text-[12px] text-[var(--text-muted)]">Step 1 of 2</span>
        </div>
      </StepHeader>

      <div className="mt-[18px] flex h-[34px] items-center gap-2 rounded-lg border border-[var(--border)] px-2.5 focus-within:border-[var(--text-muted)]">
        <Search className="h-[13px] w-[13px] shrink-0 text-[var(--text-muted)]" />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKeyDown}
          aria-label="Search providers"
          aria-controls="agent-onboarding-providers"
          placeholder={providers ? `Search ${providers.length} providers` : 'Search providers'}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
        />
      </div>

      <div
        ref={listRef}
        id="agent-onboarding-providers"
        role="listbox"
        aria-label="Providers"
        className="agent-onboarding-provider-list mt-2 h-[234px] overflow-y-auto pr-1.5"
      >
        {loadError ? (
          <div className="px-2.5 py-2 text-[12px] text-[var(--error)]">{loadError}</div>
        ) : !providers ? (
          <div className="flex items-center gap-2 px-2.5 py-2 text-[12px] text-[var(--text-muted)]">
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading providers…
          </div>
        ) : matches.length === 0 ? (
          <div className="px-2.5 py-2 text-[12px] text-[var(--text-muted)]">No providers match.</div>
        ) : (
          matches.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={index === active}
              data-provider-index={index}
              data-provider-id={item.id}
              onMouseMove={() => setActive(index)}
              onClick={() => onPick(item)}
              className={`flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] text-[var(--text-primary)] ${
                index === active ? 'bg-[var(--bg-tertiary)]' : ''
              }`}
            >
              <BubbleProviderLogo providerId={item.id} name={item.name} />
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              {index === active ? <EnterHint /> : null}
            </button>
          ))
        )}
      </div>

      <StepFooter
        left={
          <button type="button" onClick={onUseAnotherAgent} className={QUIET_LINK}>
            Use another agent
          </button>
        }
        right={
          <button type="button" onClick={onLater} className={QUIET_LINK}>
            Later
          </button>
        }
      />
    </div>
  );
}

function BackTile({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex h-[30px] w-[30px] items-center justify-center rounded-lg border border-[var(--border)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)]"
    >
      <ArrowLeft className="h-3.5 w-3.5" />
    </button>
  );
}

function BubbleKeyStep({
  provider,
  onBack,
  onSaved,
  onUseAnotherAgent,
  onLater,
}: {
  provider: BubbleProviderSummary;
  onBack: () => void;
  onSaved: () => Promise<boolean>;
  onUseAnotherAgent: () => void;
  onLater: () => void;
}) {
  const [key, setKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = key.trim();
    if (!trimmed) {
      setError('Enter your API key.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await window.electron.setBubbleProviderKey(provider.id, trimmed);
      await window.electron.setBubbleDefaultProvider(provider.id);
      // Composer model pickers re-read Bubble's catalog on this event.
      window.dispatchEvent(new Event('bubble-model-config-updated'));
      if (!(await onSaved())) {
        setError("Key saved, but Bubble isn't ready yet. Check it in Settings.");
      }
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save the key.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(event) => void save(event)} className="px-7 pb-5 pt-7" noValidate>
      <StepHeader title={`Add your ${provider.name} key`} subtitle="Add more providers anytime in Settings.">
        <div className="flex items-center justify-between">
          <BackTile onClick={onBack} label="Back to providers" />
          <span className="text-[12px] text-[var(--text-muted)]">Step 2 of 2</span>
        </div>
      </StepHeader>

      <div className="mt-[22px] flex flex-col gap-1.5">
        <label htmlFor="agent-onboarding-key" className="text-[12px] text-[var(--text-secondary)]">
          {provider.name} API key
        </label>
        <div
          className={`flex h-[34px] items-center rounded-lg border pl-2.5 pr-[3px] focus-within:border-[var(--text-muted)] ${
            error ? 'border-[var(--error)]' : 'border-[var(--border)]'
          }`}
        >
          <input
            id="agent-onboarding-key"
            autoFocus
            type={showKey ? 'text' : 'password'}
            value={key}
            onChange={(event) => {
              setKey(event.target.value);
              setError(null);
            }}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            aria-describedby="agent-onboarding-key-note"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--text-primary)] outline-none"
          />
          <button
            type="button"
            onClick={() => setShowKey((value) => !value)}
            aria-label={showKey ? 'Hide key' : 'Show key'}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
          >
            {showKey ? <EyeOff className="h-[15px] w-[15px]" /> : <Eye className="h-[15px] w-[15px]" />}
          </button>
        </div>
        <div
          id="agent-onboarding-key-note"
          className={`text-[12px] ${error ? 'text-[var(--error)]' : 'text-[var(--text-muted)]'}`}
        >
          {error ?? 'Stored on this computer only.'}
        </div>
      </div>

      <button type="submit" disabled={saving} className={`${PRIMARY_BUTTON} mt-5 h-9 w-full`}>
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        {saving ? 'Saving…' : 'Save and start'}
      </button>

      <StepFooter
        left={
          <button type="button" onClick={onUseAnotherAgent} className={QUIET_LINK}>
            Use another agent
          </button>
        }
        right={
          <button type="button" onClick={onLater} className={QUIET_LINK}>
            Later
          </button>
        }
      />
    </form>
  );
}

type AgentRowProps = {
  entry: AgentRuntimeEntry;
  installing: boolean;
  installError: InstallFailure | null;
  notFoundAfterInstall: boolean;
  signInOpen: boolean;
  onInstall: () => void;
  onToggleSignIn: () => void;
  /** Built-in agents configure a key in the panel instead of a CLI sign-in. */
  onAddKey?: () => void;
  /** Tighter rows for the overview's "Needs setup" list. */
  compact?: boolean;
};

const OUTLINE_BUTTON =
  'inline-flex h-7 shrink-0 items-center rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]';

export function AgentRow({
  entry,
  installing,
  installError,
  notFoundAfterInstall,
  signInOpen,
  onInstall,
  onToggleSignIn,
  onAddKey,
  compact = false,
}: AgentRowProps) {
  const canInstall = entry.state === 'not_installed' && entry.canAutoInstall;
  const showSignIn = entry.state === 'login_required' && entry.loginCommand !== null && signInOpen;

  return (
    <div className={compact ? 'py-1.5' : 'px-5 py-3'} data-agent-row={entry.provider}>
      <div className="flex min-h-7 items-center gap-3">
        <ProviderLogo provider={entry.provider} className="h-4 w-4 shrink-0" />
        <div
          className={`min-w-0 flex-1 truncate text-[13px] text-[var(--text-primary)] ${compact ? '' : 'font-medium'}`}
        >
          {entry.title}
          {entry.version ? (
            <span className="ml-1.5 font-normal text-[var(--text-muted)]">{entry.version}</span>
          ) : null}
        </div>
        <RowAction
          entry={entry}
          canInstall={canInstall}
          installing={installing}
          installError={installError}
          signInOpen={signInOpen}
          onInstall={onInstall}
          onToggleSignIn={onToggleSignIn}
          onAddKey={onAddKey}
        />
      </div>

      {installing ? (
        <div className="ml-7 mt-2 space-y-2">
          <div className="h-0.5 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
            <div className="aegis-onboarding-progress h-full w-2/5 rounded-full bg-[var(--text-primary)]" />
          </div>
          <div className="truncate font-mono text-[11px] text-[var(--text-muted)]">{entry.installCommand}</div>
        </div>
      ) : null}

      {installError ? (
        <div className="ml-7 mt-2 space-y-2 text-[12px] leading-[18px]">
          <div className="text-[var(--error)]">
            {installError.message}{' '}
            {installError.reason === 'npm_missing' ? (
              <button
                type="button"
                onClick={() => void window.electron.openExternalUrl(NODE_DOWNLOAD_URL)}
                className="inline-flex items-center gap-0.5 underline underline-offset-2"
              >
                Get Node.js
                <ExternalLink className="h-3 w-3" />
              </button>
            ) : null}
          </div>
          {entry.installCommand ? (
            <>
              <div className="text-[var(--text-secondary)]">Or install it yourself in Terminal:</div>
              <CommandField command={entry.installCommand} label={`${entry.title} install command`} />
            </>
          ) : null}
        </div>
      ) : null}

      {notFoundAfterInstall && entry.state === 'not_installed' && !installing ? (
        <div className="ml-7 mt-2 text-[12px] leading-[18px] text-[var(--text-secondary)]">
          Installed, but Aegis can't find the {entry.title} command yet. Check that npm's global bin
          folder is on your PATH, then restart Aegis.
        </div>
      ) : null}

      {showSignIn ? (
        <div className="ml-7 mt-2 space-y-2 text-[12px] leading-[18px]">
          <div className="text-[var(--text-secondary)]">Run this in Terminal. Aegis checks again when you come back.</div>
          <CommandField command={entry.loginCommand!} label={`${entry.title} sign-in command`} />
        </div>
      ) : null}

      {entry.state === 'error' && entry.detail ? (
        <div className="ml-7 mt-1 text-[12px] leading-[18px] text-[var(--text-muted)]">{entry.detail}</div>
      ) : null}
    </div>
  );
}

function RowAction({
  entry,
  canInstall,
  installing,
  installError,
  signInOpen,
  onInstall,
  onToggleSignIn,
  onAddKey,
}: Omit<AgentRowProps, 'entry' | 'notFoundAfterInstall' | 'compact'> & { entry: AgentRuntimeEntry; canInstall: boolean }) {
  if (entry.state === 'ready') {
    return (
      <span className="inline-flex items-center gap-1 text-[12px] text-[var(--text-secondary)]">
        <Check className="h-3.5 w-3.5" />
        Ready
      </span>
    );
  }
  if (installing) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] text-[var(--text-secondary)]">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Installing…
      </span>
    );
  }
  if (canInstall) {
    return (
      <button type="button" onClick={onInstall} className={OUTLINE_BUTTON}>
        {installError ? 'Try again' : 'Install'}
      </button>
    );
  }
  if (entry.state === 'login_required' && onAddKey) {
    return (
      <button type="button" onClick={onAddKey} className={OUTLINE_BUTTON}>
        Add key
      </button>
    );
  }
  if (entry.state === 'login_required') {
    return entry.loginCommand ? (
      <button type="button" onClick={onToggleSignIn} aria-expanded={signInOpen} className={OUTLINE_BUTTON}>
        Sign in
      </button>
    ) : (
      <span className="text-[12px] text-[var(--text-muted)]">Not signed in</span>
    );
  }
  if (entry.state === 'not_installed' && entry.docsUrl) {
    return (
      <button
        type="button"
        onClick={() => void window.electron.openExternalUrl(entry.docsUrl!)}
        className="inline-flex items-center gap-1 text-[12px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
      >
        Setup guide
        <ExternalLink className="h-3 w-3" />
      </button>
    );
  }
  return (
    <span className="text-[12px] text-[var(--text-muted)]">
      {entry.state === 'error' ? 'Check failed' : 'Not installed'}
    </span>
  );
}

function CommandField({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Failed to copy.');
    }
  };

  return (
    <div className="flex items-center gap-2">
      <code className="flex h-[30px] min-w-0 flex-1 items-center truncate rounded-md bg-[var(--bg-tertiary)] px-2.5 font-mono text-[12px] text-[var(--text-primary)]">
        {command}
      </code>
      <button type="button" onClick={() => void copy()} aria-label={`Copy ${label}`} className={`${OUTLINE_BUTTON} h-[30px]`}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function AgentRowSkeleton() {
  return (
    <div className="flex h-[52px] items-center gap-3 px-5">
      <div className="h-4 w-4 shrink-0 animate-pulse rounded bg-[var(--bg-tertiary)]" />
      <div className="h-3 w-28 animate-pulse rounded bg-[var(--bg-tertiary)]" />
    </div>
  );
}

import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Eye,
  EyeOff,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import claudeLogo from '../../assets/claude-color.svg';
import openaiLogo from '../../assets/openai.svg';
import minimaxLogo from '../../assets/minimax-color.svg';
import deepseekLogo from '../../assets/deepseek-color.svg';
import moonshotLogo from '../../assets/moonshot.svg';
import zhipuLogo from '../../assets/zhipu-color.svg';
import { useClaudeRuntimeStatus } from '../../hooks/useClaudeRuntimeStatus';
import { useCodexRuntimeStatus } from '../../hooks/useCodexRuntimeStatus';
import { Badge } from '../ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import type {
  ClaudeCompatibleProviderConfig,
  ClaudeCompatibleProviderId,
  ClaudeCompatibleProvidersConfig,
  ClaudeRuntimeStatus,
  CodexRuntimeStatus,
} from '../../types';
import { normalizeCompatibleProvidersConfig } from '../../hooks/useCompatibleProviderConfig';

const DEFAULT_CONFIG = normalizeCompatibleProvidersConfig(undefined);
const PROVIDER_IDS = ['minimax', 'zhipu', 'moonshot', 'deepseek'] as ClaudeCompatibleProviderId[];

type RuntimeTargetId = 'claude-runtime' | 'codex-runtime';

const PROVIDER_META: Record<
  ClaudeCompatibleProviderId,
  { label: string; logo: string; description: string }
> = {
  minimax: {
    label: 'MiniMax (CN)',
    logo: minimaxLogo,
    description: 'Anthropic-compatible endpoint for Claude Code access in mainland China.',
  },
  zhipu: {
    label: 'Zhipu AI',
    logo: zhipuLogo,
    description: 'GLM-backed compatible routing for Claude Code sessions and tool use.',
  },
  moonshot: {
    label: 'Moonshot AI',
    logo: moonshotLogo,
    description: 'Kimi-compatible endpoint for Claude Code requests and fast fallbacks.',
  },
  deepseek: {
    label: 'DeepSeek',
    logo: deepseekLogo,
    description: 'DeepSeek chat and reasoning models exposed through a compatible API surface.',
  },
};

export function CompatibleProviderSettingsContent() {
  const [config, setConfig] = useState<ClaudeCompatibleProvidersConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [selectedRuntimeId, setSelectedRuntimeId] = useState<RuntimeTargetId>('claude-runtime');
  const [selectedProviderId, setSelectedProviderId] = useState<ClaudeCompatibleProviderId>('minimax');
  const [providerDialogOpen, setProviderDialogOpen] = useState(false);
  const [draftProvider, setDraftProvider] = useState<ClaudeCompatibleProviderConfig>(
    DEFAULT_CONFIG.providers.minimax
  );
  const [showSecret, setShowSecret] = useState(false);
  const [savingProvider, setSavingProvider] = useState<ClaudeCompatibleProviderId | null>(null);
  const [message, setMessage] = useState<{ providerId: ClaudeCompatibleProviderId; text: string } | null>(null);

  const {
    status: claudeRuntimeStatus,
    loading: claudeRuntimeLoading,
    refresh: refreshClaudeRuntimeStatus,
  } = useClaudeRuntimeStatus();
  const {
    status: codexRuntimeStatus,
    loading: codexRuntimeLoading,
    refresh: refreshCodexRuntimeStatus,
  } = useCodexRuntimeStatus();

  useEffect(() => {
    let cancelled = false;

    window.electron
      .getClaudeCompatibleProviderConfig()
      .then((nextConfig) => {
        if (!cancelled) {
          setConfig(normalizeCompatibleProvidersConfig(nextConfig));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setDraftProvider({ ...config.providers[selectedProviderId] });
    setShowSecret(false);
  }, [config, selectedProviderId]);

  const selectedProviderMeta = PROVIDER_META[selectedProviderId];
  const selectedProvider = config.providers[selectedProviderId];
  const providerMessage =
    message?.providerId === selectedProviderId
      ? message.text
      : 'These providers are Anthropic-compatible endpoints used when Claude Code is routed away from the default Anthropic backend.';

  const isDirty = useMemo(
    () => JSON.stringify(draftProvider) !== JSON.stringify(selectedProvider),
    [draftProvider, selectedProvider]
  );

  const updateDraftProvider = (
    updater: (current: ClaudeCompatibleProviderConfig) => ClaudeCompatibleProviderConfig
  ) => {
    setDraftProvider((current) => updater(current));
  };

  const handleSave = async () => {
    setSavingProvider(selectedProviderId);
    setMessage(null);

    try {
      const nextConfig = normalizeCompatibleProvidersConfig({
        providers: {
          ...config.providers,
          [selectedProviderId]: draftProvider,
        },
      });
      const saved = await window.electron.saveClaudeCompatibleProviderConfig(nextConfig);
      setConfig(normalizeCompatibleProvidersConfig(saved));
      window.dispatchEvent(new CustomEvent('claude-compatible-provider-updated'));
      setMessage({
        providerId: selectedProviderId,
        text: 'Saved. Restart Claude sessions to apply the new provider.',
      });
      setProviderDialogOpen(false);
    } catch (error) {
      setMessage({
        providerId: selectedProviderId,
        text: error instanceof Error ? error.message : 'Failed to save provider config.',
      });
    } finally {
      setSavingProvider(null);
    }
  };

  const handleResetDraft = () => {
    if (savingProvider) {
      return;
    }

    setDraftProvider({ ...config.providers[selectedProviderId] });
    setShowSecret(false);
  };

  const openProviderDialog = (providerId: ClaudeCompatibleProviderId) => {
    if (savingProvider) {
      return;
    }
    setSelectedProviderId(providerId);
    setProviderDialogOpen(true);
  };

  const closeProviderDialog = () => {
    if (savingProvider) {
      return;
    }
    setProviderDialogOpen(false);
    setShowSecret(false);
  };

  return (
    <section className="space-y-6">
      <SectionCard>
        <div className="mb-4">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
            Providers
          </div>
          <h3 className="mt-2 text-lg font-semibold text-[var(--text-primary)]">Claude Code Routing</h3>
          <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
            Check runtime readiness on the left, then configure compatible providers for Claude Code on the right.
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
          <div className="overflow-hidden rounded-[18px] border border-[var(--border)] bg-[var(--bg-secondary)]">
            <div className="border-b border-[var(--border)] px-4 py-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--text-muted)]">
                Routing Stack
              </div>
              <div className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
                Agent checks live here. Claude-compatible provider configuration appears in the Claude Code workspace.
              </div>
            </div>

            <div className="space-y-4 p-2.5">
              <RailSection
                label="Agent Checks"
                description="Verify the local runtimes used to start new Claude Code and Codex sessions."
              >
                <RuntimeRailItem
                  title="Claude Code Runtime"
                  logo={claudeLogo}
                  summary={claudeRuntimeLoading ? 'Checking Claude runtime…' : claudeRuntimeStatus.summary}
                  status={buildClaudeRailStatus(claudeRuntimeStatus, claudeRuntimeLoading)}
                  selected={selectedRuntimeId === 'claude-runtime'}
                  onSelect={() => setSelectedRuntimeId('claude-runtime')}
                />
                <RuntimeRailItem
                  title="Codex ACP Runtime"
                  logo={openaiLogo}
                  summary={buildCodexSummary(codexRuntimeStatus, codexRuntimeLoading)}
                  status={buildCodexRailStatus(codexRuntimeStatus, codexRuntimeLoading)}
                  selected={selectedRuntimeId === 'codex-runtime'}
                  onSelect={() => setSelectedRuntimeId('codex-runtime')}
                />
              </RailSection>
            </div>
          </div>

          {selectedRuntimeId === 'claude-runtime' ? (
            <ClaudeProviderWorkspace
              claudeStatus={claudeRuntimeStatus}
              claudeLoading={claudeRuntimeLoading}
              onRefresh={refreshClaudeRuntimeStatus}
              providerIds={PROVIDER_IDS}
              config={config}
              loading={loading}
              selectedProviderId={selectedProviderId}
              selectedProviderMeta={selectedProviderMeta}
              savingProvider={savingProvider}
              onOpenProvider={openProviderDialog}
            />
          ) : (
            <CodexRuntimeDetailPanel
              status={codexRuntimeStatus}
              loading={codexRuntimeLoading}
              onRefresh={refreshCodexRuntimeStatus}
            />
          )}
        </div>
      </SectionCard>

      <Dialog open={providerDialogOpen} onOpenChange={(open) => !open && closeProviderDialog()}>
        <DialogContent className="max-w-2xl rounded-[20px] border border-[var(--border)] bg-[var(--bg-primary)] p-0 shadow-[0_18px_48px_rgba(0,0,0,0.12)]">
          <div className="overflow-hidden rounded-[20px]">
            <div className="border-b border-[var(--border)] bg-[var(--bg-secondary)] px-6 py-5">
              <DialogHeader className="space-y-2 text-left">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2.5 text-base font-medium text-[var(--text-primary)]">
                      <img
                        src={selectedProviderMeta.logo}
                        alt=""
                        className="h-5 w-5 flex-shrink-0"
                        aria-hidden="true"
                      />
                      <DialogTitle className="text-base font-medium">{selectedProviderMeta.label}</DialogTitle>
                      <Badge
                        variant={draftProvider.enabled ? 'accent' : 'muted'}
                        className="border-transparent px-2.5 py-0.5 text-[11px] font-medium"
                      >
                        {draftProvider.enabled ? 'Active' : 'Disabled'}
                      </Badge>
                    </div>
                    <DialogDescription className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
                      {selectedProviderMeta.description}
                    </DialogDescription>
                  </div>

                  <button
                    type="button"
                    onClick={() =>
                      updateDraftProvider((current) => ({
                        ...current,
                        enabled: !current.enabled,
                      }))
                    }
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors ${
                      draftProvider.enabled
                        ? 'border-transparent bg-[var(--accent)]'
                        : 'border-[var(--border)] bg-[var(--bg-tertiary)]'
                    }`}
                    disabled={savingProvider !== null}
                  >
                    <span
                      className={`pointer-events-none block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                        draftProvider.enabled ? 'translate-x-5' : 'translate-x-0.5'
                      }`}
                    />
                  </button>
                </div>
              </DialogHeader>
            </div>

            <div className="space-y-5 px-6 py-6">
              <Field
                label="Base URL"
                description="Compatible endpoint Claude Code should use for requests."
              >
                <input
                  value={draftProvider.baseUrl}
                  onChange={(event) =>
                    updateDraftProvider((current) => ({
                      ...current,
                      baseUrl: event.target.value,
                    }))
                  }
                  placeholder="https://your-compatible-endpoint/v1"
                  className="h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--text-muted)]"
                  disabled={savingProvider !== null}
                />
              </Field>

              <Field
                label="Model"
                description="Default model name passed to the compatible provider."
              >
                <input
                  value={draftProvider.model}
                  onChange={(event) =>
                    updateDraftProvider((current) => ({
                      ...current,
                      model: event.target.value,
                    }))
                  }
                  placeholder={getProviderModelPlaceholder(selectedProviderId)}
                  className="h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--text-muted)]"
                  disabled={savingProvider !== null}
                />
              </Field>

              <Field
                label="Small Fast Model"
                description="Optional lower-latency override for lightweight Claude Code requests."
              >
                <input
                  value={draftProvider.smallFastModel || ''}
                  onChange={(event) =>
                    updateDraftProvider((current) => ({
                      ...current,
                      smallFastModel: event.target.value,
                    }))
                  }
                  placeholder={
                    selectedProviderId === 'deepseek'
                      ? 'deepseek-chat or deepseek-reasoner'
                      : 'Optional override'
                  }
                  className="h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--text-muted)]"
                  disabled={savingProvider !== null}
                />
              </Field>

              <Field
                label="Auth Token"
                description="Stored locally and sent as the bearer token for this endpoint."
              >
                <div className="relative">
                  <input
                    type={showSecret ? 'text' : 'password'}
                    value={draftProvider.secret}
                    onChange={(event) =>
                      updateDraftProvider((current) => ({
                        ...current,
                        authType: 'auth_token',
                        secret: event.target.value,
                      }))
                    }
                    placeholder="token..."
                    className="h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] px-3 pr-11 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--text-muted)]"
                    disabled={savingProvider !== null}
                  />
                  <button
                    type="button"
                    onClick={() => setShowSecret((current) => !current)}
                    className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-xl text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
                    aria-label={showSecret ? 'Hide key' : 'Show key'}
                    disabled={savingProvider !== null}
                  >
                    {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </Field>

              <div className="rounded-[16px] border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-3 text-sm text-[var(--text-secondary)]">
                {providerMessage}
              </div>
            </div>

            <DialogFooter className="border-t border-[var(--border)] bg-[var(--bg-secondary)] px-6 py-4">
              <div className="mr-auto text-sm text-[var(--text-muted)]">
                {isDirty ? 'Unsaved changes' : 'Saved and in sync'}
              </div>
              <button
                type="button"
                onClick={closeProviderDialog}
                disabled={savingProvider !== null}
                className="rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-2 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
              >
                Close
              </button>
              <button
                type="button"
                onClick={handleResetDraft}
                disabled={!isDirty || savingProvider !== null}
                className="rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-2 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
              >
                Reset
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={!isDirty || savingProvider !== null}
                className="rounded-[14px] border border-[var(--border)] bg-[var(--accent-light)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
              >
                {savingProvider === selectedProviderId ? 'Saving...' : 'Save'}
              </button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function ClaudeProviderWorkspace({
  claudeStatus,
  claudeLoading,
  onRefresh,
  providerIds,
  config,
  loading,
  selectedProviderId,
  selectedProviderMeta,
  savingProvider,
  onOpenProvider,
  }: {
  claudeStatus: ClaudeRuntimeStatus;
  claudeLoading: boolean;
  onRefresh: () => void;
  providerIds: readonly ClaudeCompatibleProviderId[];
  config: ClaudeCompatibleProvidersConfig;
  loading: boolean;
  selectedProviderId: ClaudeCompatibleProviderId;
  selectedProviderMeta: { label: string; logo: string; description: string };
  savingProvider: ClaudeCompatibleProviderId | null;
  onOpenProvider: (providerId: ClaudeCompatibleProviderId) => void;
}) {
  const railStatus = buildClaudeRailStatus(claudeStatus, claudeLoading);

  return (
    <DetailShell
      logo={claudeLogo}
      title="Claude Code Runtime"
      description="Compatible providers below are used to route Claude Code through Anthropic-style endpoints."
      statusLabel={railStatus.label}
      statusTone={railStatus.tone}
      headerAction={<RefreshIconButton onClick={onRefresh} loading={claudeLoading} />}
    >
      {!claudeLoading && !claudeStatus.ready ? (
        <StatusBanner
          loading={false}
          ready={false}
          summary={claudeStatus.summary}
          detail={claudeStatus.detail}
        />
      ) : null}

      <div className="grid gap-4">
        <div className="overflow-hidden rounded-[16px] border border-[var(--border)] bg-[var(--bg-primary)]">
          <div className="border-b border-[var(--border)] px-4 py-3">
            <SectionEyebrow>Compatible Providers</SectionEyebrow>
            <div className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
              These providers expose Anthropic-compatible APIs for Claude Code.
            </div>
          </div>

          <div className="max-h-[420px] overflow-y-auto p-2.5">
            <div className="space-y-2 pr-1">
            {providerIds.map((providerId) => {
              const provider = config.providers[providerId];
              const meta = PROVIDER_META[providerId];

              return (
                <ProviderRailItem
                  key={providerId}
                  label={meta.label}
                  logo={meta.logo}
                  provider={provider}
                  selected={selectedProviderId === providerId}
                  disabled={loading || savingProvider !== null}
                  onSelect={() => onOpenProvider(providerId)}
                />
              );
            })}
            </div>
          </div>
        </div>
      </div>
    </DetailShell>
  );
}

function CodexRuntimeDetailPanel({
  status,
  loading,
  onRefresh,
}: {
  status: CodexRuntimeStatus;
  loading: boolean;
  onRefresh: () => void;
}) {
  const railStatus = buildCodexRailStatus(status, loading);
  const details = [
    { label: 'CLI', value: status.cliAvailable ? 'Detected' : 'Missing' },
    { label: 'Config', value: status.configExists ? 'Found' : 'Not found' },
    { label: 'Models', value: status.hasModelConfig ? 'Ready' : 'Empty' },
    { label: 'Session Readiness', value: status.ready ? 'Available' : 'Blocked' },
  ];

  return (
    <DetailShell
      logo={openaiLogo}
      title="Codex ACP Runtime"
      description="Checks whether the local Codex ACP CLI and configuration are ready for new Codex sessions."
      statusLabel={railStatus.label}
      statusTone={railStatus.tone}
      headerAction={<RefreshIconButton onClick={onRefresh} loading={loading} />}
    >
      <StatusBanner
        loading={loading}
        ready={status.ready}
        summary={buildCodexSummary(status, loading)}
        detail="Codex needs the local CLI, a config file, and a configured model before new ACP sessions can start."
      />

      <div className="grid gap-3 sm:grid-cols-2">
        {details.map((item) => (
          <DetailFactCard key={item.label} label={item.label} value={item.value} />
        ))}
      </div>
    </DetailShell>
  );
}

function RailSection({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2.5">
      <div className="px-1">
        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
          {label}
        </div>
        <div className="mt-1 text-[12px] leading-5 text-[var(--text-secondary)]">
          {description}
        </div>
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function RuntimeRailItem({
  title,
  logo,
  summary,
  status,
  selected,
  onSelect,
}: {
  title: string;
  logo: string;
  summary: string;
  status: { label: string; tone: string; dot: string };
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`group flex w-full items-start gap-3 rounded-[16px] border px-3.5 py-3 text-left transition-colors ${
        selected
          ? 'border-[var(--sidebar-item-border)] bg-[var(--sidebar-item-active)] shadow-sm'
          : 'border-transparent bg-[var(--bg-secondary)]/92 hover:bg-[var(--bg-tertiary)]/55'
      }`}
    >
      <img
        src={logo}
        alt=""
        className="mt-0.5 h-5 w-5 flex-shrink-0"
        aria-hidden="true"
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <div className="truncate text-sm font-medium text-[var(--text-primary)]">{title}</div>
          <div className="flex items-center gap-1.5">
            <span className={`h-2.5 w-2.5 rounded-full ${status.dot}`} />
            <span className={`text-[11px] font-medium ${status.tone}`}>{status.label}</span>
          </div>
        </div>
        <div className="mt-1 line-clamp-2 text-[12px] leading-5 text-[var(--text-secondary)]">
          {summary}
        </div>
      </div>

      <div className="flex flex-shrink-0 items-center gap-2 text-[var(--text-muted)]">
        <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
      </div>
    </button>
  );
}

function ProviderRailItem({
  label,
  logo,
  provider,
  selected,
  disabled,
  onSelect,
}: {
  label: string;
  logo: string;
  provider: ClaudeCompatibleProviderConfig;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={`group flex w-full items-start gap-3 rounded-[16px] border px-3.5 py-3 text-left transition-colors disabled:opacity-60 ${
        selected
          ? 'border-[var(--sidebar-item-border)] bg-[var(--sidebar-item-active)] shadow-sm'
          : 'border-transparent bg-[var(--bg-secondary)]/92 hover:bg-[var(--bg-tertiary)]/55'
      }`}
    >
      <img
        src={logo}
        alt=""
        className="mt-0.5 h-5 w-5 flex-shrink-0"
        aria-hidden="true"
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <div className="truncate text-sm font-medium text-[var(--text-primary)]">{label}</div>
          <Badge
            variant={provider.enabled ? 'accent' : 'muted'}
            className="border-transparent text-[10px] font-medium"
          >
            {provider.enabled ? 'On' : 'Off'}
          </Badge>
        </div>
      </div>

      <div className="flex flex-shrink-0 items-center gap-2 text-[var(--text-muted)]">
        {disabled ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />}
      </div>
    </button>
  );
}

function DetailShell({
  logo,
  title,
  description,
  statusLabel,
  statusTone,
  headerAction,
  children,
}: {
  logo: string;
  title: string;
  description: string;
  statusLabel: string;
  statusTone: string;
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-[18px] border border-[var(--border)] bg-[var(--bg-secondary)]">
      <div className="border-b border-[var(--border)] px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <img
                src={logo}
                alt=""
                className="h-5 w-5 flex-shrink-0"
                aria-hidden="true"
              />
              <div className="text-[22px] font-semibold tracking-[-0.02em] text-[var(--text-primary)]">
                {title}
              </div>
              <Badge
                variant="outline"
                className={`border-[var(--border)] bg-[var(--bg-primary)] px-2.5 py-0.5 text-[11px] font-medium ${statusTone}`}
              >
                {statusLabel}
              </Badge>
            </div>
            <div className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
              {description}
            </div>
          </div>

          {headerAction}
        </div>
      </div>

      <div className="space-y-5 px-5 py-5">
        {children}
      </div>
    </div>
  );
}

function StatusBanner({
  loading,
  ready,
  summary,
  detail,
}: {
  loading: boolean;
  ready: boolean;
  summary: string;
  detail: string;
}) {
  return (
    <div className="rounded-[16px] border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[12px] bg-[var(--bg-secondary)]">
          {loading ? (
            <RefreshCw className="h-4 w-4 animate-spin text-[var(--text-secondary)]" />
          ) : ready ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-700" />
          ) : (
            <AlertTriangle className="h-4 w-4 text-[#dc2626]" />
          )}
        </div>

        <div className="min-w-0">
          <div className="text-[15px] font-semibold text-[var(--text-primary)]">{summary}</div>
          <div className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">{detail}</div>
        </div>
      </div>
    </div>
  );
}

function DetailFactCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] p-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--text-muted)]">
        {label}
      </div>
      <div className="mt-2 break-words text-[15px] font-medium text-[var(--text-primary)]">
        {value}
      </div>
    </div>
  );
}

function RefreshIconButton({
  onClick,
  loading,
}: {
  onClick: () => void;
  loading: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-secondary)] transition-colors hover:border-[var(--text-muted)] hover:text-[var(--text-primary)]"
      aria-label="Refresh runtime status"
      title="Refresh runtime status"
    >
      <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
    </button>
  );
}

function SectionCard({ children }: { children: ReactNode }) {
  return (
    <section className="rounded-[20px] border border-[var(--border)] bg-[var(--bg-primary)]/82 p-5 shadow-[0_10px_30px_rgba(0,0,0,0.04)]">
      {children}
    </section>
  );
}

function SectionEyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--text-muted)]">
      {children}
    </div>
  );
}

function Field({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium text-[var(--text-primary)]">{label}</div>
      {description ? (
        <div className="text-[13px] leading-5 text-[var(--text-secondary)]">{description}</div>
      ) : null}
      {children}
    </div>
  );
}

function getProviderModelPlaceholder(providerId: ClaudeCompatibleProviderId): string {
  switch (providerId) {
    case 'minimax':
      return 'MiniMax-M2.5';
    case 'zhipu':
      return 'glm-5';
    case 'moonshot':
      return 'kimi-k2.5';
    case 'deepseek':
      return 'deepseek-chat or deepseek-reasoner';
    default:
      return 'Model name';
  }
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

function buildClaudeRailStatus(status: ClaudeRuntimeStatus, loading: boolean) {
  if (loading) {
    return {
      label: 'Checking',
      tone: 'text-[var(--text-secondary)]',
      dot: 'bg-[var(--text-muted)]/60',
    };
  }

  if (status.ready) {
    return {
      label: 'Connected',
      tone: 'text-emerald-700',
      dot: 'bg-emerald-500',
    };
  }

  if (status.kind === 'install_required') {
    return {
      label: 'Install',
      tone: 'text-amber-700',
      dot: 'bg-amber-500',
    };
  }

  if (status.kind === 'login_required') {
    return {
      label: 'Sign in',
      tone: 'text-amber-700',
      dot: 'bg-amber-500',
    };
  }

  return {
    label: 'Attention',
    tone: 'text-[#dc2626]',
    dot: 'bg-[#dc2626]',
  };
}

function buildCodexRailStatus(status: CodexRuntimeStatus, loading: boolean) {
  if (loading) {
    return {
      label: 'Checking',
      tone: 'text-[var(--text-secondary)]',
      dot: 'bg-[var(--text-muted)]/60',
    };
  }

  if (status.ready) {
    return {
      label: 'Connected',
      tone: 'text-emerald-700',
      dot: 'bg-emerald-500',
    };
  }

  return {
    label: 'Setup',
    tone: 'text-amber-700',
    dot: 'bg-amber-500',
  };
}

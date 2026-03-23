import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Eye,
  EyeOff,
  LoaderCircle,
  Search,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import claudeLogo from '../../assets/claude-color.svg';
import openaiLogo from '../../assets/openai.svg';
import minimaxLogo from '../../assets/minimax-color.svg';
import deepseekLogo from '../../assets/deepseek-color.svg';
import moonshotLogo from '../../assets/moonshot.svg';
import mimoLogo from '../../assets/xiaomimimo.svg';
import zhipuLogo from '../../assets/zhipu-color.svg';
import { useClaudeRuntimeStatus } from '../../hooks/useClaudeRuntimeStatus';
import { useCodexModelConfig } from '../../hooks/useCodexModelConfig';
import { useOpencodeModelConfig } from '../../hooks/useOpencodeModelConfig';
import { useCodexRuntimeStatus } from '../../hooks/useCodexRuntimeStatus';
import { useOpencodeRuntimeStatus } from '../../hooks/useOpencodeRuntimeStatus';
import { formatCodexModelLabel } from '../../utils/codex-model';
import { Badge } from '../ui/badge';
import { OpenCodeLogo } from '../OpenCodeLogo';
import { Input } from '../ui/input';
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
  CodexModelConfig,
  CodexRuntimeStatus,
  OpenCodeModelConfig,
  OpenCodeRuntimeStatus,
} from '../../types';
import { normalizeCompatibleProvidersConfig } from '../../hooks/useCompatibleProviderConfig';

const DEFAULT_CONFIG = normalizeCompatibleProvidersConfig(undefined);
const PROVIDER_IDS = ['minimaxCn', 'minimax', 'mimo', 'zhipu', 'moonshot', 'deepseek'] as ClaudeCompatibleProviderId[];

type RuntimeTargetId = 'claude-runtime' | 'codex-runtime' | 'opencode-runtime';

const PROVIDER_META: Record<
  ClaudeCompatibleProviderId,
  { label: string; logo: string; description: string }
> = {
  minimaxCn: {
    label: 'MiniMax (CN)',
    logo: minimaxLogo,
    description: 'Anthropic-compatible endpoint for Claude Code access through MiniMax China routing.',
  },
  minimax: {
    label: 'MiniMax (GLOBAL)',
    logo: minimaxLogo,
    description: 'Anthropic-compatible endpoint for Claude Code access through MiniMax global routing.',
  },
  mimo: {
    label: 'MiMo',
    logo: mimoLogo,
    description: 'Xiaomi MiMo compatible endpoint for Claude Code requests and reasoning workloads.',
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
  const [selectedProviderId, setSelectedProviderId] = useState<ClaudeCompatibleProviderId>('minimaxCn');
  const [providerDialogOpen, setProviderDialogOpen] = useState(false);
  const [draftProvider, setDraftProvider] = useState<ClaudeCompatibleProviderConfig>(
    DEFAULT_CONFIG.providers.minimaxCn
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
  } = useCodexRuntimeStatus();
  const {
    status: opencodeRuntimeStatus,
    loading: opencodeRuntimeLoading,
  } = useOpencodeRuntimeStatus();
  const codexModelConfig = useCodexModelConfig();
  const opencodeModelConfig = useOpencodeModelConfig();

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
  const providerMessage = message?.providerId === selectedProviderId ? message.text : null;

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
    setMessage(null);
    setProviderDialogOpen(false);
    setShowSecret(false);
  };

  return (
    <section className="space-y-6">
      <SectionCard>
        <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
          <div className="overflow-hidden rounded-[18px] border border-[var(--border)] bg-[var(--bg-secondary)]">
            <div className="p-2.5">
              <RailSection
                label="Agent Checks"
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
                  title="Codex CLI ACP"
                  logo={openaiLogo}
                  summary={buildCodexSummary(codexRuntimeStatus, codexRuntimeLoading)}
                  status={buildCodexRailStatus(codexRuntimeStatus, codexRuntimeLoading)}
                  selected={selectedRuntimeId === 'codex-runtime'}
                  onSelect={() => setSelectedRuntimeId('codex-runtime')}
                />
                <RuntimeRailItem
                  title="OpenCode ACP"
                  logo={<OpenCodeLogo className="h-5 w-5 flex-shrink-0" />}
                  summary={buildOpencodeSummary(opencodeRuntimeStatus, opencodeRuntimeLoading)}
                  status={buildOpencodeRailStatus(opencodeRuntimeStatus, opencodeRuntimeLoading)}
                  selected={selectedRuntimeId === 'opencode-runtime'}
                  onSelect={() => setSelectedRuntimeId('opencode-runtime')}
                />
              </RailSection>
            </div>
          </div>

          {selectedRuntimeId === 'claude-runtime' ? (
            <ClaudeProviderWorkspace
              claudeStatus={claudeRuntimeStatus}
              claudeLoading={claudeRuntimeLoading}
              providerIds={PROVIDER_IDS}
              config={config}
              loading={loading}
              selectedProviderId={selectedProviderId}
              savingProvider={savingProvider}
              onOpenProvider={openProviderDialog}
            />
          ) : selectedRuntimeId === 'codex-runtime' ? (
            <CodexRuntimeDetailPanel
              modelConfig={codexModelConfig}
              loading={codexRuntimeLoading}
              saveVisibility={window.electron.saveCodexModelVisibility}
              updatedEventName="codex-model-config-updated"
              formatModelLabel={formatCodexModelLabel}
              loadingMessage="Checking local Codex models..."
              emptyMessage="No local Codex models were detected yet. Models will appear automatically when the local Codex cache is ready."
              saveErrorMessage="Failed to update Codex model visibility."
            />
          ) : (
            <CodexRuntimeDetailPanel
              modelConfig={opencodeModelConfig}
              loading={opencodeRuntimeLoading}
              saveVisibility={window.electron.saveOpencodeModelVisibility}
              updatedEventName="opencode-model-config-updated"
              formatModelLabel={(name) => name}
              showRawModelName={false}
              loadingMessage="Checking local OpenCode models..."
              emptyMessage="No local OpenCode models were detected yet. Models will appear automatically when the local OpenCode cache is ready."
              saveErrorMessage="Failed to update OpenCode model visibility."
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
                label="Max Output Tokens"
                description="Optional Claude Code max output token override passed through provider env."
              >
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={draftProvider.maxOutputTokens ?? ''}
                  onChange={(event) =>
                    updateDraftProvider((current) => ({
                      ...current,
                      maxOutputTokens: event.target.value
                        ? Math.max(1, Math.trunc(Number(event.target.value)))
                        : undefined,
                    }))
                  }
                  placeholder={selectedProviderId === 'mimo' ? '64000' : 'Optional override'}
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

              {providerMessage && (
                <div className="rounded-[16px] border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-3 text-sm text-[var(--text-secondary)]">
                  {providerMessage}
                </div>
              )}
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
  providerIds,
  config,
  loading,
  selectedProviderId,
  savingProvider,
  onOpenProvider,
  }: {
  claudeStatus: ClaudeRuntimeStatus;
  claudeLoading: boolean;
  providerIds: readonly ClaudeCompatibleProviderId[];
  config: ClaudeCompatibleProvidersConfig;
  loading: boolean;
  selectedProviderId: ClaudeCompatibleProviderId;
  savingProvider: ClaudeCompatibleProviderId | null;
  onOpenProvider: (providerId: ClaudeCompatibleProviderId) => void;
}) {
  return (
    <div className="space-y-4">
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
    </div>
  );
}

function CodexRuntimeDetailPanel({
  modelConfig,
  loading,
  saveVisibility,
  updatedEventName,
  formatModelLabel,
  showRawModelName = true,
  loadingMessage,
  emptyMessage,
  saveErrorMessage,
}: {
  modelConfig: CodexModelConfig | OpenCodeModelConfig;
  loading: boolean;
  saveVisibility: (enabledModels: string[]) => Promise<{ availableModels: Array<{ name: string; enabled: boolean; isDefault: boolean }> }>;
  updatedEventName: string;
  formatModelLabel: (name: string) => string;
  showRawModelName?: boolean;
  loadingMessage: string;
  emptyMessage: string;
  saveErrorMessage: string;
}) {
  const normalizedAvailableModels = modelConfig.availableModels || [];
  const [availableModels, setAvailableModels] = useState(normalizedAvailableModels);
  const [modelSearchQuery, setModelSearchQuery] = useState('');
  const [savingModelName, setSavingModelName] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setAvailableModels(normalizedAvailableModels);
  }, [normalizedAvailableModels]);

  const filteredModels = useMemo(() => {
    const query = modelSearchQuery.trim().toLowerCase();
    if (!query) {
      return availableModels;
    }

    return availableModels.filter((model) => {
      const formattedLabel = formatModelLabel(model.name).toLowerCase();
      return model.name.toLowerCase().includes(query) || formattedLabel.includes(query);
    });
  }, [availableModels, formatModelLabel, modelSearchQuery]);

  const handleToggleModel = async (modelName: string, enabled: boolean) => {
    const nextModels = availableModels.map((model) =>
      model.name === modelName ? { ...model, enabled } : model
    );
    setAvailableModels(nextModels);
    setSavingModelName(modelName);
    setSaveError(null);

    try {
      const saved = await saveVisibility(
        nextModels.filter((model) => model.enabled).map((model) => model.name)
      );
      setAvailableModels(saved.availableModels || []);
      window.dispatchEvent(new CustomEvent(updatedEventName));
    } catch (error) {
      setAvailableModels(normalizedAvailableModels);
      setSaveError(error instanceof Error ? error.message : saveErrorMessage);
    } finally {
      setSavingModelName(null);
    }
  };

  return (
    <div className="overflow-hidden rounded-[18px] border border-[var(--border)] bg-[var(--bg-secondary)]">
      <div className="space-y-5 px-5 py-5">
      {saveError ? (
        <div className="rounded-[14px] border border-[#fecaca] bg-[#fef2f2] px-4 py-3 text-sm text-[#b91c1c]">
          {saveError}
        </div>
      ) : null}

      {availableModels.length > 0 ? (
        <>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
            <Input
              value={modelSearchQuery}
              onChange={(event) => setModelSearchQuery(event.target.value)}
              placeholder="Search models"
              className="h-11 rounded-[14px] border-[var(--border)] bg-[var(--bg-primary)] pl-9 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus-visible:ring-[var(--accent)]"
            />
          </div>

        <div className="max-h-[560px] overflow-y-auto pr-1">
          <div className="space-y-2">
          {filteredModels.map((model) => {
            const toggling = savingModelName === model.name;

            return (
              <div
                key={model.name}
                className="flex items-center gap-4 rounded-[16px] border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <div className="truncate text-sm font-medium text-[var(--text-primary)]">
                      {formatModelLabel(model.name)}
                    </div>
                    {model.isDefault ? (
                      <Badge
                        variant="outline"
                        className="border-[var(--border)] bg-[var(--bg-secondary)] text-[10px] font-medium text-[var(--text-secondary)]"
                      >
                        Default
                      </Badge>
                    ) : null}
                  </div>
                  {showRawModelName ? (
                    <div className="mt-1 truncate text-[13px] text-[var(--text-secondary)]">
                      {model.name}
                    </div>
                  ) : null}
                </div>

                <div className="flex items-center gap-3">
                  <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-muted)]">
                    {model.enabled ? 'Shown' : 'Hidden'}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleToggleModel(model.name, !model.enabled)}
                    disabled={loading || toggling}
                    aria-label={`${model.enabled ? 'Hide' : 'Show'} ${model.name} in model picker`}
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors disabled:opacity-60 ${
                      model.enabled
                        ? 'border-transparent bg-[var(--accent)]'
                        : 'border-[var(--border)] bg-[var(--bg-secondary)]'
                    }`}
                  >
                    <span
                      className={`pointer-events-none block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                        model.enabled ? 'translate-x-5' : 'translate-x-0.5'
                      }`}
                    />
                  </button>
                  {toggling ? <LoaderCircle className="h-4 w-4 animate-spin text-[var(--text-muted)]" /> : null}
                </div>
              </div>
            );
          })}

          {filteredModels.length === 0 ? (
            <div className="rounded-[16px] border border-dashed border-[var(--border)] bg-[var(--bg-primary)] px-4 py-6 text-sm leading-6 text-[var(--text-secondary)]">
              No models match "{modelSearchQuery.trim()}".
            </div>
          ) : null}
          </div>
        </div>
        </>
      ) : (
        <div className="rounded-[16px] border border-dashed border-[var(--border)] bg-[var(--bg-primary)] px-4 py-6 text-sm leading-6 text-[var(--text-secondary)]">
          {loading ? loadingMessage : emptyMessage}
        </div>
      )}
      </div>
    </div>
  );
}

function RailSection({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2.5">
      <div className="px-1">
        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
          {label}
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
  logo: ReactNode | string;
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
      <div className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center">
        {typeof logo === 'string' ? (
          <img src={logo} alt="" className="h-5 w-5 flex-shrink-0" aria-hidden="true" />
        ) : (
          logo
        )}
      </div>

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
    case 'minimaxCn':
    case 'minimax':
      return 'MiniMax-M2.5';
    case 'mimo':
      return 'mimo-v2-pro';
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
    return 'Codex CLI ACP is ready.';
  }

  if (!status.cliAvailable) {
    return 'Codex CLI ACP was not found.';
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

function buildOpencodeSummary(status: OpenCodeRuntimeStatus, loading: boolean): string {
  if (loading) {
    return 'Checking OpenCode runtime...';
  }

  if (status.ready) {
    return 'OpenCode ACP is ready.';
  }

  if (!status.cliAvailable) {
    return 'OpenCode ACP was not found.';
  }

  return 'OpenCode needs local setup.';
}

function buildOpencodeRailStatus(status: OpenCodeRuntimeStatus, loading: boolean) {
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

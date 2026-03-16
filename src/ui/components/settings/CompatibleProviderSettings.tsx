import { Eye, EyeOff, ChevronRight, LoaderCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import minimaxLogo from '../../assets/minimax-color.svg';
import deepseekLogo from '../../assets/deepseek-color.svg';
import moonshotLogo from '../../assets/moonshot.svg';
import zhipuLogo from '../../assets/zhipu-color.svg';
import { ProvidersRuntimeStatusPanel } from '../ProvidersRuntimeStatusPanel';
import { useClaudeRuntimeStatus } from '../../hooks/useClaudeRuntimeStatus';
import { useCodexRuntimeStatus } from '../../hooks/useCodexRuntimeStatus';
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
} from '../../types';
import { normalizeCompatibleProvidersConfig } from '../../hooks/useCompatibleProviderConfig';

const DEFAULT_CONFIG = normalizeCompatibleProvidersConfig(undefined);

const PROVIDER_META: Record<
  ClaudeCompatibleProviderId,
  { label: string; logo: string }
> = {
  minimax: {
    label: 'MiniMax (CN)',
    logo: minimaxLogo,
  },
  zhipu: {
    label: 'Zhipu AI',
    logo: zhipuLogo,
  },
  moonshot: {
    label: 'Moonshot AI',
    logo: moonshotLogo,
  },
  deepseek: {
    label: 'DeepSeek',
    logo: deepseekLogo,
  },
};

export function CompatibleProviderSettingsContent() {
  const [config, setConfig] = useState<ClaudeCompatibleProvidersConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [editingProviderId, setEditingProviderId] = useState<ClaudeCompatibleProviderId | null>(null);
  const [draftProvider, setDraftProvider] = useState<ClaudeCompatibleProviderConfig | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [savingProvider, setSavingProvider] = useState<ClaudeCompatibleProviderId | null>(null);
  const [message, setMessage] = useState<{ providerId: ClaudeCompatibleProviderId; text: string } | null>(null);
  const providerIds = useMemo(
    () => ['minimax', 'zhipu', 'moonshot', 'deepseek'] as ClaudeCompatibleProviderId[],
    []
  );
  const {
    status: runtimeStatus,
    loading: runtimeLoading,
    refresh: refreshRuntimeStatus,
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

  const editingMeta = editingProviderId ? PROVIDER_META[editingProviderId] : null;
  const editingMessage =
    editingProviderId && message?.providerId === editingProviderId
      ? message.text
      : 'Changes apply to new Claude sessions after saving.';

  const openProviderEditor = (providerId: ClaudeCompatibleProviderId) => {
    setEditingProviderId(providerId);
    setDraftProvider({ ...config.providers[providerId] });
    setShowSecret(false);
  };

  const closeProviderEditor = () => {
    if (savingProvider) {
      return;
    }
    setEditingProviderId(null);
    setDraftProvider(null);
    setShowSecret(false);
  };

  const updateDraftProvider = (updater: (current: ClaudeCompatibleProviderConfig) => ClaudeCompatibleProviderConfig) => {
    setDraftProvider((current) => (current ? updater(current) : current));
  };

  const handleSave = async () => {
    if (!editingProviderId || !draftProvider) {
      return;
    }

    setSavingProvider(editingProviderId);
    setMessage(null);

    try {
      const nextConfig = normalizeCompatibleProvidersConfig({
        providers: {
          ...config.providers,
          [editingProviderId]: draftProvider,
        },
      });
      const saved = await window.electron.saveClaudeCompatibleProviderConfig(nextConfig);
      setConfig(normalizeCompatibleProvidersConfig(saved));
      window.dispatchEvent(new CustomEvent('claude-compatible-provider-updated'));
      setMessage({
        providerId: editingProviderId,
        text: 'Saved. Restart Claude sessions to apply the new provider.',
      });
      closeProviderEditor();
    } catch (error) {
      setMessage({
        providerId: editingProviderId,
        text: error instanceof Error ? error.message : 'Failed to save provider config.',
      });
    } finally {
      setSavingProvider(null);
    }
  };

  return (
    <section className="space-y-6">
      <ProvidersRuntimeStatusPanel
        claudeStatus={runtimeStatus}
        claudeLoading={runtimeLoading}
        codexStatus={codexRuntimeStatus}
        codexLoading={codexRuntimeLoading}
        onRefresh={() => {
          refreshRuntimeStatus();
          refreshCodexRuntimeStatus();
        }}
      />

      <SectionCard>
        <div className="mb-4">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
            Provider Setup
          </div>
          <h3 className="mt-2 text-lg font-semibold text-[var(--text-primary)]">Configured Providers</h3>
          <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
            Configure Anthropic-compatible providers and route Claude sessions through them.
          </p>
        </div>

        <div className="space-y-3">
          {providerIds.map((providerId) => {
            const provider = config.providers[providerId];
            const meta = PROVIDER_META[providerId];
            const providerMessage =
              message?.providerId === providerId ? message.text : 'Open to edit endpoint, model, and auth token.';

            return (
              <ProviderCard
                key={providerId}
                providerId={providerId}
                label={meta.label}
                logo={meta.logo}
                provider={provider}
                disabled={loading}
                onOpen={() => openProviderEditor(providerId)}
              />
            );
          })}
        </div>
      </SectionCard>

      <Dialog open={editingProviderId !== null} onOpenChange={(open) => !open && closeProviderEditor()}>
        <DialogContent className="max-w-2xl rounded-[24px] border border-[var(--border)] bg-[var(--bg-primary)] p-0 shadow-[0_18px_48px_rgba(0,0,0,0.12)]">
          {editingProviderId && draftProvider && editingMeta && (
            <div className="overflow-hidden rounded-[24px]">
              <div className="border-b border-[var(--border)] bg-[var(--bg-secondary)] px-6 py-5">
                <DialogHeader className="space-y-2 text-left">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2.5 text-base font-medium text-[var(--text-primary)]">
                        <img
                          src={editingMeta.logo}
                          alt=""
                          className="h-5 w-5 flex-shrink-0"
                          aria-hidden="true"
                        />
                        <DialogTitle className="text-base font-medium">{editingMeta.label}</DialogTitle>
                      </div>
                      <DialogDescription className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
                        Configure the Anthropic-compatible endpoint, model, and auth token for this provider.
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

              <div className="space-y-4 px-6 py-6">
                <Field label="Base URL">
                  <input
                    value={draftProvider.baseUrl}
                    onChange={(event) =>
                      updateDraftProvider((current) => ({
                        ...current,
                        baseUrl: event.target.value,
                      }))
                    }
                    placeholder="https://your-compatible-endpoint/v1"
                    className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--text-muted)]"
                    disabled={savingProvider !== null}
                  />
                </Field>

                <Field label="Model">
                  <input
                    value={draftProvider.model}
                    onChange={(event) =>
                      updateDraftProvider((current) => ({
                        ...current,
                        model: event.target.value,
                      }))
                    }
                    placeholder={getProviderModelPlaceholder(editingProviderId)}
                    className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--text-muted)]"
                    disabled={savingProvider !== null}
                  />
                </Field>

                <Field label="Small fast model (optional)">
                  <input
                    value={draftProvider.smallFastModel || ''}
                    onChange={(event) =>
                      updateDraftProvider((current) => ({
                        ...current,
                        smallFastModel: event.target.value,
                      }))
                    }
                    placeholder={
                      editingProviderId === 'deepseek'
                        ? 'deepseek-chat or deepseek-reasoner'
                        : 'Optional override'
                    }
                    className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--text-muted)]"
                    disabled={savingProvider !== null}
                  />
                </Field>

                <Field label="Auth token">
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
                      className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 pr-11 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--text-muted)]"
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

                <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)]/70 px-4 py-3 text-sm text-[var(--text-secondary)]">
                  {editingMessage}
                </div>
              </div>

              <DialogFooter className="border-t border-[var(--border)] bg-[var(--bg-secondary)] px-6 py-4">
                <button
                  type="button"
                  onClick={closeProviderEditor}
                  disabled={savingProvider !== null}
                  className="rounded-full border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-2 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={savingProvider !== null}
                  className="rounded-full border border-[var(--border)] bg-[var(--accent-light)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
                >
                  {savingProvider === editingProviderId ? 'Saving...' : 'Save'}
                </button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function SectionCard({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-[24px] border border-[var(--border)] bg-[var(--bg-primary)]/82 p-5 shadow-[0_10px_30px_rgba(0,0,0,0.04)]">
      {children}
    </section>
  );
}

function ProviderCard({
  providerId,
  label,
  logo,
  provider,
  disabled,
  onOpen,
}: {
  providerId: ClaudeCompatibleProviderId;
  label: string;
  logo: string;
  provider: ClaudeCompatibleProviderConfig;
  disabled: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={disabled}
      className="group flex w-full items-start gap-4 rounded-[22px] border border-[var(--border)] bg-[var(--bg-secondary)]/92 px-4 py-4 text-left shadow-sm transition-colors hover:bg-[var(--bg-tertiary)]/55 disabled:opacity-60"
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
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
              provider.enabled
                ? 'bg-[var(--accent-light)] text-[var(--accent)]'
                : 'bg-[var(--bg-primary)] text-[var(--text-muted)]'
            }`}
          >
            {provider.enabled ? 'On' : 'Off'}
          </span>
        </div>
      </div>

      <div className="flex flex-shrink-0 items-center gap-2 text-[var(--text-muted)]">
        {disabled ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />}
      </div>
    </button>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium text-[var(--text-primary)]">{label}</div>
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

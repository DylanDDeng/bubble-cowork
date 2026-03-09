import { Eye, EyeOff } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import minimaxLogo from '../../assets/minimax-color.svg';
import moonshotLogo from '../../assets/moonshot.svg';
import zhipuLogo from '../../assets/zhipu-color.svg';
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
};

export function CompatibleProviderSettingsContent() {
  const [config, setConfig] = useState<ClaudeCompatibleProvidersConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [selectedProviderId, setSelectedProviderId] = useState<ClaudeCompatibleProviderId>('minimax');
  const [savingProvider, setSavingProvider] = useState<ClaudeCompatibleProviderId | null>(null);
  const [message, setMessage] = useState<{ providerId: ClaudeCompatibleProviderId; text: string } | null>(null);
  const [visibleSecrets, setVisibleSecrets] = useState<
    Partial<Record<ClaudeCompatibleProviderId, boolean>>
  >({});
  const providerIds = useMemo(
    () => ['minimax', 'zhipu', 'moonshot'] as ClaudeCompatibleProviderId[],
    []
  );

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

  const updateProvider = (
    providerId: ClaudeCompatibleProviderId,
    updater: (current: ClaudeCompatibleProviderConfig) => ClaudeCompatibleProviderConfig
  ) => {
    setConfig((current) => ({
      providers: {
        ...current.providers,
        [providerId]: updater(current.providers[providerId]),
      },
    }));
  };

  const handleSave = async (providerId: ClaudeCompatibleProviderId) => {
    setSavingProvider(providerId);
    setMessage(null);
    try {
      const saved = await window.electron.saveClaudeCompatibleProviderConfig(
        normalizeCompatibleProvidersConfig(config)
      );
      setConfig(normalizeCompatibleProvidersConfig(saved));
      window.dispatchEvent(new CustomEvent('claude-compatible-provider-updated'));
      setMessage({
        providerId,
        text: 'Saved. Restart Claude sessions to apply the new provider.',
      });
    } catch (error) {
      setMessage({
        providerId,
        text: error instanceof Error ? error.message : 'Failed to save provider config.',
      });
    } finally {
      setSavingProvider(null);
    }
  };

  const selectedProvider = config.providers[selectedProviderId];
  const selectedMeta = PROVIDER_META[selectedProviderId];
  const showSecret = visibleSecrets[selectedProviderId] === true;
  const selectedMessage =
    message?.providerId === selectedProviderId
      ? message.text
      : 'Changes apply to new Claude sessions after saving.';

  return (
    <section>
      <div className="grid gap-6 xl:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="rounded-[24px] border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
          <div className="px-3 pb-3 pt-2">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
              Configured Providers
            </div>
          </div>
          <div className="space-y-1">
            {providerIds.map((providerId) => {
              const provider = config.providers[providerId];
              const meta = PROVIDER_META[providerId];
              const selected = providerId === selectedProviderId;

              return (
                <button
                  key={providerId}
                  type="button"
                  onClick={() => setSelectedProviderId(providerId)}
                  className={`flex w-full items-start gap-3 rounded-2xl px-3 py-3 text-left transition-colors ${
                    selected
                      ? 'bg-[var(--bg-tertiary)]'
                      : 'hover:bg-[var(--bg-tertiary)]/70'
                  }`}
                >
                  <img
                    src={meta.logo}
                    alt=""
                    className="mt-0.5 h-5 w-5 flex-shrink-0"
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-3">
                      <div className="truncate text-sm font-medium text-[var(--text-primary)]">
                        {meta.label}
                      </div>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          provider.enabled
                            ? 'bg-[var(--accent-light)] text-[var(--accent)]'
                            : 'bg-[var(--bg-primary)] text-[var(--text-muted)]'
                        }`}
                      >
                        {provider.enabled ? 'On' : 'Off'}
                      </span>
                    </div>
                    <div className="mt-1 truncate text-xs text-[var(--text-secondary)]">
                      {provider.model || 'No model configured'}
                    </div>
                    <div className="mt-1 truncate text-[11px] text-[var(--text-muted)]">
                      {provider.baseUrl || 'Base URL not set'}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        <div className="rounded-[24px] border border-[var(--border)] bg-[var(--bg-secondary)] p-6">
          <div className="flex items-start justify-between gap-6">
            <div className="max-w-2xl">
              <div className="flex items-center gap-2.5 text-base font-medium text-[var(--text-primary)]">
                <img
                  src={selectedMeta.logo}
                  alt=""
                  className="h-5 w-5 flex-shrink-0"
                  aria-hidden="true"
                />
                {selectedMeta.label}
              </div>
              <div className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
                Configure the Anthropic-compatible endpoint, model, and auth token for this provider.
              </div>
            </div>

            <button
              type="button"
              onClick={() =>
                updateProvider(selectedProviderId, (current) => ({
                  ...current,
                  enabled: !current.enabled,
                }))
              }
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors ${
                selectedProvider.enabled
                  ? 'border-transparent bg-[var(--accent)]'
                  : 'border-[var(--border)] bg-[var(--bg-tertiary)]'
              }`}
              disabled={loading}
            >
              <span
                className={`pointer-events-none block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                  selectedProvider.enabled ? 'translate-x-5' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-2">
            <Field label="Base URL">
              <input
                value={selectedProvider.baseUrl}
                onChange={(event) =>
                  updateProvider(selectedProviderId, (current) => ({
                    ...current,
                    baseUrl: event.target.value,
                  }))
                }
                placeholder="https://your-compatible-endpoint/v1"
                className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--text-muted)]"
                disabled={loading}
              />
            </Field>

            <Field label="Model">
              <input
                value={selectedProvider.model}
                onChange={(event) =>
                  updateProvider(selectedProviderId, (current) => ({
                    ...current,
                    model: event.target.value,
                  }))
                }
                placeholder={
                  selectedProviderId === 'minimax'
                    ? 'MiniMax-M2.5'
                    : selectedProviderId === 'zhipu'
                      ? 'glm-5'
                      : 'kimi-k2.5'
                }
                className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--text-muted)]"
                disabled={loading}
              />
            </Field>

            <Field label="Auth token" className="md:col-span-2">
              <div className="relative">
                <input
                  type={showSecret ? 'text' : 'password'}
                  value={selectedProvider.secret}
                  onChange={(event) =>
                    updateProvider(selectedProviderId, (current) => ({
                      ...current,
                      authType: 'auth_token',
                      secret: event.target.value,
                    }))
                  }
                  placeholder="token..."
                  className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 pr-11 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--text-muted)]"
                  disabled={loading}
                />
                <button
                  type="button"
                  onClick={() =>
                    setVisibleSecrets((current) => ({
                      ...current,
                      [selectedProviderId]: !showSecret,
                    }))
                  }
                  className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-xl text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
                  aria-label={showSecret ? 'Hide key' : 'Show key'}
                  disabled={loading}
                >
                  {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </Field>
          </div>

          <div className="mt-6 flex items-center justify-between gap-4">
            <div className="text-sm text-[var(--text-secondary)]">
              {selectedMessage}
            </div>

            <button
              type="button"
              onClick={() => handleSave(selectedProviderId)}
              disabled={loading || savingProvider !== null}
              className="rounded-full border border-[var(--border)] bg-[var(--accent-light)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
            >
              {savingProvider === selectedProviderId ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className ? `space-y-2 ${className}` : 'space-y-2'}>
      <div className="text-sm font-medium text-[var(--text-primary)]">{label}</div>
      {children}
    </div>
  );
}

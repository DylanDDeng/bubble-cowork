import { Eye, EyeOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import minimaxLogo from '../../assets/minimax-color.svg';
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
};

export function CompatibleProviderSettingsContent() {
  const [config, setConfig] = useState<ClaudeCompatibleProvidersConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [savingProvider, setSavingProvider] = useState<ClaudeCompatibleProviderId | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [visibleSecrets, setVisibleSecrets] = useState<
    Partial<Record<ClaudeCompatibleProviderId, boolean>>
  >({});

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
      setMessage('Saved. Restart Claude sessions to apply the new provider.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to save provider config.');
    } finally {
      setSavingProvider(null);
    }
  };

  return (
    <section>
      <div className="space-y-6">
        {(['minimax', 'zhipu'] as ClaudeCompatibleProviderId[]).map((providerId) => {
          const provider = config.providers[providerId];
          const meta = PROVIDER_META[providerId];
          const showSecret = visibleSecrets[providerId] === true;

          return (
            <div
              key={providerId}
              className="rounded-[24px] border border-[var(--border)] bg-[var(--bg-secondary)] p-6"
            >
              <div className="flex items-start justify-between gap-6">
                <div className="max-w-2xl">
                  <div className="flex items-center gap-2.5 text-base font-medium text-[var(--text-primary)]">
                    <img
                      src={meta.logo}
                      alt=""
                      className="h-5 w-5 flex-shrink-0"
                      aria-hidden="true"
                    />
                    {meta.label}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() =>
                    updateProvider(providerId, (current) => ({
                      ...current,
                      enabled: !current.enabled,
                    }))
                  }
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors ${
                    provider.enabled
                      ? 'border-transparent bg-[var(--accent)]'
                      : 'border-[var(--border)] bg-[var(--bg-tertiary)]'
                  }`}
                  disabled={loading}
                >
                  <span
                    className={`pointer-events-none block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                      provider.enabled ? 'translate-x-5' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>

              <div className="mt-6 grid gap-4 md:grid-cols-2">
                <Field label="Base URL">
                  <input
                    value={provider.baseUrl}
                    onChange={(event) =>
                      updateProvider(providerId, (current) => ({
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
                    value={provider.model}
                    onChange={(event) =>
                      updateProvider(providerId, (current) => ({
                        ...current,
                        model: event.target.value,
                      }))
                    }
                    placeholder={providerId === 'minimax' ? 'MiniMax-M2.5' : 'glm-5'}
                    className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--text-muted)]"
                    disabled={loading}
                  />
                </Field>

                <Field label="Auth token" className="md:col-span-2">
                  <div className="relative">
                    <input
                      type={showSecret ? 'text' : 'password'}
                      value={provider.secret}
                      onChange={(event) =>
                        updateProvider(providerId, (current) => ({
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
                          [providerId]: !showSecret,
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
                  {message || 'Changes apply to new Claude sessions after saving.'}
                </div>

                <button
                  type="button"
                  onClick={() => handleSave(providerId)}
                  disabled={loading || savingProvider !== null}
                  className="rounded-full border border-[var(--border)] bg-[var(--accent-light)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
                >
                  {savingProvider === providerId ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
          );
        })}
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

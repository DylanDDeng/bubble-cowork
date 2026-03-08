import { useEffect, useState } from 'react';
import type { ClaudeCompatibleProviderConfig } from '../../types';

const DEFAULT_CONFIG: ClaudeCompatibleProviderConfig = {
  enabled: false,
  baseUrl: '',
  authType: 'api_key',
  secret: '',
  model: '',
};

export function CompatibleProviderSettingsContent() {
  const [config, setConfig] = useState<ClaudeCompatibleProviderConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    window.electron
      .getClaudeCompatibleProviderConfig()
      .then((nextConfig) => {
        if (!cancelled) {
          setConfig(nextConfig);
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

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const saved = await window.electron.saveClaudeCompatibleProviderConfig(config);
      setConfig(saved);
      window.dispatchEvent(new CustomEvent('claude-compatible-provider-updated'));
      setMessage('Saved. Restart Claude sessions to apply the new provider.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to save provider config.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <div className="rounded-[24px] border border-[var(--border)] bg-[var(--bg-secondary)] p-6">
        <div className="flex items-start justify-between gap-6">
          <div className="max-w-2xl">
            <div className="text-base font-medium text-[var(--text-primary)]">
              MiniMax (CN)
            </div>
          </div>

          <button
            type="button"
            onClick={() => setConfig((current) => ({ ...current, enabled: !current.enabled }))}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors ${
              config.enabled
                ? 'border-transparent bg-[var(--accent)]'
                : 'border-[var(--border)] bg-[var(--bg-tertiary)]'
            }`}
            disabled={loading}
          >
            <span
              className={`pointer-events-none block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                config.enabled ? 'translate-x-5' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <Field label="Base URL">
            <input
              value={config.baseUrl}
              onChange={(event) => setConfig((current) => ({ ...current, baseUrl: event.target.value }))}
              placeholder="https://your-compatible-endpoint/v1"
              className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--text-muted)]"
              disabled={loading}
            />
          </Field>

          <Field label="Model">
            <input
              value={config.model}
              onChange={(event) => setConfig((current) => ({ ...current, model: event.target.value }))}
              placeholder="MiniMax-M2.1"
              className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--text-muted)]"
              disabled={loading}
            />
          </Field>

          <Field label="Auth type">
            <div className="flex gap-2">
              {[
                { value: 'api_key', label: 'API Key' },
                { value: 'auth_token', label: 'Auth Token' },
              ].map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() =>
                    setConfig((current) => ({
                      ...current,
                      authType: option.value as ClaudeCompatibleProviderConfig['authType'],
                    }))
                  }
                  className={`rounded-full px-3 py-1.5 text-sm transition-colors ${
                    config.authType === option.value
                      ? 'bg-[var(--accent)] text-[var(--accent-foreground)]'
                      : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                  disabled={loading}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </Field>

          <Field label={config.authType === 'auth_token' ? 'Auth token' : 'API key'}>
            <input
              type="password"
              value={config.secret}
              onChange={(event) => setConfig((current) => ({ ...current, secret: event.target.value }))}
              placeholder={config.authType === 'auth_token' ? 'token...' : 'sk-...'}
              className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--text-muted)]"
              disabled={loading}
            />
          </Field>
        </div>

        <div className="mt-4 rounded-2xl border border-[var(--border)] bg-[var(--bg-tertiary)]/60 px-4 py-3 text-sm text-[var(--text-secondary)]">
          MiniMax example:
          <div className="mt-2 font-mono text-[12px] leading-5 text-[var(--text-primary)]">
            Base URL: `https://your-minimax-compatible-endpoint`
            <br />
            Model: `MiniMax-M2.1`
          </div>
        </div>

        <div className="mt-6 flex items-center justify-between gap-4">
          <div className="text-sm text-[var(--text-secondary)]">
            {message || 'Changes apply to new Claude sessions after saving.'}
          </div>

          <button
            type="button"
            onClick={handleSave}
            disabled={loading || saving}
            className="rounded-full border border-[var(--border)] bg-[var(--accent-light)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </section>
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

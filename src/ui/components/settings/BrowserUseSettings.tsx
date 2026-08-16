import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Globe, Plus, X } from '../icons';
import type { BrowserUsePermissionSettings } from '../../types';
import { SettingsGroup } from './SettingsPrimitives';

const POLICIES = ['ask', 'allow', 'block'] as const;
type Policy = (typeof POLICIES)[number];

const POLICY_LABELS: Record<Policy, string> = {
  ask: 'Always ask',
  allow: 'Allow browsing',
  block: 'Block browsing',
};

/**
 * Browser Use origin permissions (Codex-parity): a default policy for all
 * origins plus per-origin overrides. Consulted by every agent navigation
 * before an approval card is shown — 'allow' skips the card, 'block' denies
 * silently.
 */
export function BrowserUseSettings() {
  const [settings, setSettings] = useState<BrowserUsePermissionSettings | null>(null);
  const [originDraft, setOriginDraft] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.electron
      .getBrowserUsePermissions()
      .then((next) => {
        if (!cancelled) setSettings(next);
      })
      .catch((error) => {
        if (!cancelled) toast.error(error instanceof Error ? error.message : 'Failed to load browser permissions.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setEnabled = useCallback(async (enabled: boolean) => {
    setBusy(true);
    try {
      setSettings(await window.electron.setBrowserUseEnabled(enabled));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to toggle browser use.');
    } finally {
      setBusy(false);
    }
  }, []);

  const setDefaultPolicy = useCallback(async (policy: Policy) => {
    setBusy(true);
    try {
      setSettings(await window.electron.setBrowserUseDefaultPolicy(policy));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save the default policy.');
    } finally {
      setBusy(false);
    }
  }, []);

  const setOriginPolicy = useCallback(async (origin: string, policy: Policy | null) => {
    setBusy(true);
    try {
      setSettings(await window.electron.setBrowserUseOriginPolicy(origin, policy));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save the origin policy.');
    } finally {
      setBusy(false);
    }
  }, []);

  const addOrigin = useCallback(async () => {
    const raw = originDraft.trim();
    if (!raw) {
      toast.error('Enter an origin like https://example.com first.');
      return;
    }
    const origin = raw.startsWith('http') ? raw : `https://${raw}`;
    try {
      new URL(origin);
    } catch {
      toast.error('That does not look like a valid origin.');
      return;
    }
    setOriginDraft('');
    await setOriginPolicy(origin, 'allow');
  }, [originDraft, setOriginPolicy]);

  const entries = settings
    ? Object.entries(settings.origins).sort(([a], [b]) => a.localeCompare(b))
    : [];

  return (
    <SettingsGroup
      title="Browser Use"
      description="Origin permissions for agent-driven browsing in the session browser panel. Allow skips the approval card; Block denies navigation silently."
    >
      {!settings ? (
        <div className="px-4 py-3 text-[13px] text-[var(--text-muted)]">Loading…</div>
      ) : (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3">
            <div className="flex min-w-0 flex-col">
              <div className="text-[13px] font-medium text-[var(--text-primary)]">Enable Browser Use</div>
              <div className="mt-0.5 text-[12px] leading-5 text-[var(--text-muted)]">
                Built in — every agent gets the browser_use tool with nothing to install. Turning it off removes the tool from all agents.
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.enabled}
              disabled={busy}
              onClick={() => void setEnabled(!settings.enabled)}
              className={`relative h-5 w-9 flex-shrink-0 rounded-full transition-colors ${
                settings.enabled ? 'bg-[var(--accent)]' : 'bg-[var(--bg-tertiary)]'
              }`}
              title={settings.enabled ? 'Browser Use is on' : 'Browser Use is off'}
            >
              <span
                className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                  settings.enabled ? 'translate-x-[18px]' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3">
            <div className="flex min-w-0 flex-col">
              <div className="text-[13px] font-medium text-[var(--text-primary)]">Default for all sites</div>
              <div className="mt-0.5 text-[12px] leading-5 text-[var(--text-muted)]">
                Applies to origins without a specific rule below.
              </div>
            </div>
            <div className="flex items-center gap-1 rounded-lg bg-[var(--bg-tertiary)] p-0.5">
              {POLICIES.map((policy) => (
                <button
                  key={policy}
                  type="button"
                  disabled={busy}
                  onClick={() => void setDefaultPolicy(policy)}
                  className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
                    settings.defaultPolicy === policy
                      ? 'bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-sm'
                      : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {POLICY_LABELS[policy]}
                </button>
              ))}
            </div>
          </div>

          {entries.length > 0 ? (
            entries.map(([origin, policy]) => (
              <div key={origin} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <Globe className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
                  <span className="truncate text-[13px] text-[var(--text-primary)]" title={origin}>
                    {origin}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <div className="flex items-center gap-1 rounded-lg bg-[var(--bg-tertiary)] p-0.5">
                    {POLICIES.map((option) => (
                      <button
                        key={option}
                        type="button"
                        disabled={busy}
                        onClick={() => void setOriginPolicy(origin, option)}
                        className={`rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors ${
                          policy === option
                            ? 'bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-sm'
                            : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                        }`}
                      >
                        {option === 'ask' ? 'Ask' : option === 'allow' ? 'Allow' : 'Block'}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void setOriginPolicy(origin, null)}
                    className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                    title="Remove this rule"
                    aria-label={`Remove rule for ${origin}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))
          ) : (
            <div className="px-4 py-2.5 text-[12px] text-[var(--text-muted)]">
              No site-specific rules yet.
            </div>
          )}

          <div className="flex items-center gap-2 px-4 py-3">
            <div className="relative min-w-0 flex-1">
              <input
                type="text"
                value={originDraft}
                onChange={(event) => setOriginDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void addOrigin();
                }}
                placeholder="https://example.com"
                disabled={busy}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] py-1.5 pl-3 pr-3 text-[12px] text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--text-muted)] disabled:opacity-50"
              />
            </div>
            <button
              type="button"
              onClick={() => void addOrigin()}
              disabled={busy || !originDraft.trim()}
              className="inline-flex items-center gap-1 rounded-lg bg-[var(--text-primary)] px-3 py-1.5 text-[12px] font-medium text-[var(--bg-primary)] transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />
              Add rule
            </button>
          </div>
        </>
      )}
    </SettingsGroup>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import * as Dialog from '@/ui/components/ui/dialog';
import { Globe, Plus, X } from '../icons';
import type {
  BrowserUsePermissionSettings,
  ChromeCookieDomain,
  ChromeCookieImportCounts,
  ChromeCookieImportStatus,
  ChromeCookieProfile,
} from '../../types';
import { SettingsGroup, SettingsRow, SettingsToggle } from './SettingsPrimitives';

const POLICIES = ['ask', 'allow', 'block'] as const;
type Policy = (typeof POLICIES)[number];

const POLICY_LABELS: Record<Policy, string> = {
  ask: 'Always ask',
  allow: 'Allow browsing',
  block: 'Block browsing',
};

function describeChromeCookieImportCounts(counts: ChromeCookieImportCounts): string {
  const skipped = counts.skippedPartitioned + counts.skippedExpired + counts.skippedInvalid;
  const extras: string[] = [];
  if (skipped) extras.push(`skipped ${skipped}`);
  if (counts.failed) extras.push(`failed ${counts.failed}`);
  return `Imported ${counts.imported} of ${counts.discovered} cookies.${
    extras.length ? ` ${extras.join(', ')}.` : ''
  }`;
}

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
    <>
    <SettingsGroup
      title="Agent browsing"
      description="Let agents use the built-in browser. Allow skips the approval card; Block denies navigation silently."
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
            <SettingsToggle
              checked={settings.enabled}
              onChange={(value) => void setEnabled(value)}
              disabled={busy}
              ariaLabel="Toggle browser use"
            />
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
    <ChromeCookieImportSettings />
    </>
  );
}

function profileLabel(profile: ChromeCookieProfile): string {
  return `Google Chrome ${profile.profileName}${profile.userName ? ` · ${profile.userName}` : ''}${
    profile.hasCookies ? '' : ' (no cookies)'
  }`;
}

function ChromeCookieImportSettings() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [profiles, setProfiles] = useState<ChromeCookieProfile[]>([]);
  const [platformSupported, setPlatformSupported] = useState(true);
  const [chromeRunning, setChromeRunning] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [profilePath, setProfilePath] = useState('');
  const [domains, setDomains] = useState<ChromeCookieDomain[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<ChromeCookieImportStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingDomains, setLoadingDomains] = useState(false);
  const importedHosts = useMemo(() => new Set(status?.domains ?? []), [status?.domains]);
  const selectedProfile = profiles.find((profile) => profile.profilePath === profilePath);

  const refreshProfiles = useCallback(async () => {
    const listed = await window.electron.listChromeCookieProfiles();
    setPlatformSupported(listed.platformSupported);
    setChromeRunning(listed.chromeRunning);
    setProfiles(listed.profiles);
    setListError(listed.errorMessage ?? null);
    setProfilePath((current) => {
      if (current && listed.profiles.some((profile) => profile.profilePath === current)) return current;
      return listed.profiles.find((profile) => profile.hasCookies)?.profilePath || listed.profiles[0]?.profilePath || '';
    });
    setStatus(await window.electron.getChromeCookieImportStatus());
  }, []);

  useEffect(() => {
    let cancelled = false;
    refreshProfiles().catch((error) => {
      if (!cancelled) toast.error(error instanceof Error ? error.message : 'Failed to look for Chrome profiles.');
    });
    return () => {
      cancelled = true;
    };
  }, [refreshProfiles]);

  useEffect(() => {
    if (!dialogOpen || !profilePath) {
      return;
    }
    let cancelled = false;
    setLoadingDomains(true);
    window.electron
      .listChromeCookieDomains(profilePath)
      .then((result) => {
        if (cancelled) return;
        setDomains(result.domains);
        setSelected(new Set(result.domains.map((domain) => domain.host)));
        if (result.errorMessage) toast.error(result.errorMessage);
      })
      .catch((error) => {
        if (!cancelled) toast.error(error instanceof Error ? error.message : 'Failed to list Chrome sites.');
      })
      .finally(() => {
        if (!cancelled) setLoadingDomains(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dialogOpen, profilePath]);

  const openImportDialog = useCallback(() => {
    setDialogOpen(true);
    void refreshProfiles();
  }, [refreshProfiles]);

  const toggleDomain = useCallback((host: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(host)) next.delete(host);
      else next.add(host);
      return next;
    });
  }, []);

  const importSelected = useCallback(async () => {
    if (!profilePath || selected.size === 0) {
      toast.error('Select at least one site to import.');
      return;
    }
    setBusy(true);
    try {
      const result = await window.electron.importChromeCookies({
        profilePath,
        domains: [...selected],
      });
      if (!result.ok) {
        if (result.errorCode === 'chrome_running') setChromeRunning(true);
        const counts = result.cookies;
        if (result.errorCode === 'write_failed' && counts) {
          toast.warning(
            `${result.errorMessage || 'Some cookies could not be written.'} ${describeChromeCookieImportCounts(counts)}`
          );
        } else {
          toast.error(result.errorMessage || 'Import failed.');
        }
        if (counts?.imported) {
          setStatus(await window.electron.getChromeCookieImportStatus());
        }
        return;
      }
      const counts = result.cookies;
      toast.success(counts ? describeChromeCookieImportCounts(counts) : 'Import complete.');
      setStatus(await window.electron.getChromeCookieImportStatus());
      await refreshProfiles();
      setDialogOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Import failed.');
    } finally {
      setBusy(false);
    }
  }, [profilePath, refreshProfiles, selected]);

  const clearImported = useCallback(async () => {
    setBusy(true);
    try {
      const result = await window.electron.clearImportedChromeCookies();
      if (!result.ok) {
        toast.error(result.errorMessage || 'Failed to clear imported cookies.');
        return;
      }
      toast.success(result.removed > 0 ? `Removed ${result.removed} imported cookies.` : 'No imported cookies to clear.');
      setStatus(await window.electron.getChromeCookieImportStatus());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to clear imported cookies.');
    } finally {
      setBusy(false);
    }
  }, []);

  const canImport =
    platformSupported && !busy && !loadingDomains && selected.size > 0 && Boolean(profilePath);

  return (
    <>
      <section>
        <div className="mb-2 flex items-end justify-between gap-3 px-1">
          <div>
            <h2 className="text-[12px] font-medium text-[var(--text-muted)]">General</h2>
            <p className="mt-1 text-[12px] leading-5 text-[var(--text-muted)]">
              Copy login cookies from local Chrome into the built-in browser.
            </p>
          </div>
          <button
            type="button"
            onClick={openImportDialog}
            disabled={!platformSupported}
            className="shrink-0 rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-1.5 text-[12px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
          >
            Import…
          </button>
        </div>
        <div className="overflow-hidden rounded-[12px] border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          <div className="divide-y divide-[var(--border)]">
            {!platformSupported ? (
              <div className="px-4 py-3 text-[13px] text-[var(--text-muted)]">
                Chrome cookie import is available on macOS. Windows Chrome uses App-Bound Encryption and cannot be imported.
              </div>
            ) : status?.importedAt ? (
              <SettingsRow
                variant="card"
                align="start"
                label="Imported cookies"
                description={`${status.cookieCount > 0 ? `${status.cookieCount} cookies` : 'Cookies'}${
                  status.domains.length > 0 ? ` from ${status.domains.length} sites` : ''
                }${status.profileName ? ` · ${status.profileName}` : ''} · ${new Date(status.importedAt).toLocaleString()}. Open a new Gmail tab or wait for the current tab to reload.`}
              >
                <button
                  type="button"
                  onClick={() => void clearImported()}
                  disabled={busy}
                  className="shrink-0 rounded-lg border border-[var(--border)] px-3 py-1.5 text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
                >
                  Clear
                </button>
              </SettingsRow>
            ) : (
              <div className="px-4 py-3 text-[13px] text-[var(--text-muted)]">
                Nothing imported yet. Use Import… to copy cookies from Chrome.
              </div>
            )}
          </div>
        </div>
      </section>

      <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[80] bg-black/35 backdrop-blur-[2px]" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-[81] flex max-h-[86vh] w-[min(440px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[20px] border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_24px_80px_rgba(0,0,0,0.22)]">
            <div className="flex min-h-0 flex-1 flex-col px-5 pt-5">
              <Dialog.Title className="text-[16px] font-semibold text-[var(--text-primary)]">
                Import from browser
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-[13px] leading-5 text-[var(--text-muted)]">
                Select Chrome cookies to copy into the built-in browser. They are not removed from Chrome.
              </Dialog.Description>

              <label className="mt-4 block text-[12px] font-medium text-[var(--text-muted)]">From</label>
              <select
                value={profilePath}
                onChange={(event) => setProfilePath(event.target.value)}
                disabled={busy || profiles.length === 0}
                className="mt-1.5 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2.5 text-[13px] text-[var(--text-primary)] outline-none disabled:opacity-50"
              >
                {profiles.length === 0 ? <option value="">No Chrome profiles found</option> : null}
                {profiles.map((profile) => (
                  <option key={profile.profilePath} value={profile.profilePath}>
                    {profileLabel(profile)}
                  </option>
                ))}
              </select>

              {listError ? <p className="mt-2 text-[12px] leading-5 text-[var(--text-muted)]">{listError}</p> : null}
              <p className="mt-2 text-[12px] leading-5 text-[var(--text-muted)]">
                {chromeRunning
                  ? `Keep ${selectedProfile?.profileName ? `Google Chrome (${selectedProfile.profileName})` : 'Google Chrome'} open and logged in. Quitting Chrome first drops Google session cookies.`
                  : 'Chrome is not running. Persistent cookies can still import; Google session login may be missing until you import while Chrome is logged in.'}
              </p>

              <div className="mt-3 min-h-0 flex-1 overflow-hidden">
                {loadingDomains ? (
                  <div className="py-2 text-[12px] text-[var(--text-muted)]">Loading sites…</div>
                ) : domains.length === 0 ? (
                  <div className="py-2 text-[12px] text-[var(--text-muted)]">No cookie sites in this profile.</div>
                ) : (
                  <>
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-[12px] font-medium text-[var(--text-muted)]">Sites</span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setSelected(new Set(domains.map((domain) => domain.host)))}
                          className="text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                        >
                          Select all
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setSelected(new Set())}
                          className="text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                        >
                          Clear
                        </button>
                      </div>
                    </div>
                    <div className="max-h-40 overflow-auto rounded-xl border border-[var(--border)]">
                      {domains.map((domain) => (
                        <label
                          key={domain.host}
                          className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                        >
                          <input
                            type="checkbox"
                            checked={selected.has(domain.host)}
                            onChange={() => toggleDomain(domain.host)}
                            disabled={busy}
                          />
                          <span className="min-w-0 flex-1 truncate">{domain.host}</span>
                          {importedHosts.has(domain.host) ? (
                            <span className="shrink-0 text-[11px] text-[var(--text-muted)]">Imported</span>
                          ) : null}
                          <span className="text-[var(--text-muted)]">{domain.cookieCount}</span>
                        </label>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-4">
              <button
                type="button"
                onClick={() => setDialogOpen(false)}
                disabled={busy}
                className="rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-2 text-[13px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void importSelected()}
                disabled={!canImport}
                className="rounded-xl bg-[var(--text-primary)] px-4 py-2 text-[13px] font-medium text-[var(--bg-primary)] transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {busy ? 'Importing…' : 'Import'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

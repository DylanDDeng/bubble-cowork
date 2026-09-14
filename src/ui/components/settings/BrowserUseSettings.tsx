import { useCallback, useEffect, useState } from 'react';
import * as Menu from '../ui/dropdown-menu';
import { toast } from 'sonner';
import * as Dialog from '@/ui/components/ui/dialog';
import { Check, ChevronDown, Cookie, X } from '../icons';
import type {
  BrowserUsePermissionSettings,
  ChromeCookieImportCounts,
  ChromeCookieImportStatus,
  ChromeCookieProfile,
} from '../../types';
import { SettingsGroup, SettingsRow, SettingsToggle } from './SettingsPrimitives';

/**
 * Browser Use master switch. Per-origin Ask/Allow/Block still exists in
 * the main process (cookie import pins imported hosts to ask), but the
 * settings page only exposes enable/disable so the list of sites does not
 * crowd the Browser tab.
 */
export function BrowserUseSettings() {
  const [settings, setSettings] = useState<BrowserUsePermissionSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoadError(false);
    window.electron
      .getBrowserUsePermissions()
      .then((next) => {
        if (!cancelled) setSettings(next);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [retry]);

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

  return (
    <>
    <SettingsGroup title="Agent browsing">
      {loadError ? <div role="alert" className="py-3">Could not load browser permissions. <button className="settings-button" onClick={() => setRetry(value => value + 1)}>Retry</button></div> : !settings ? (
        <div className="px-4 py-2.5 text-[13px] text-[var(--text-muted)]">Loading…</div>
      ) : (
        <SettingsRow
          variant="card"
          label="Enable Browser Use"
        >
          <SettingsToggle
            checked={settings.enabled}
            onChange={(value) => void setEnabled(value)}
            disabled={busy}
            ariaLabel="Toggle browser use"
          />
        </SettingsRow>
      )}
    </SettingsGroup>
    <ChromeCookieImportSettings />
    </>
  );
}

function describeChromeCookieImportCounts(counts: ChromeCookieImportCounts): string {
  const skipped = counts.skippedPartitioned + counts.skippedExpired + counts.skippedInvalid;
  const extras: string[] = [];
  if (skipped) extras.push(`skipped ${skipped}`);
  if (counts.failed) extras.push(`failed ${counts.failed}`);
  return `Imported ${counts.imported} of ${counts.discovered} cookies.${
    extras.length ? ` ${extras.join(', ')}.` : ''
  }`;
}

function profileLabel(profile: ChromeCookieProfile): string {
  return `Google Chrome ${profile.profileName}${profile.userName ? ` · ${profile.userName}` : ''}`;
}

function ChromeMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden>
      <circle cx="24" cy="24" r="20" fill="#FBBC05" />
      <path fill="#EA4335" d="M24 24L6.679 14A20 20 0 0 1 41.321 14Z" />
      <path fill="#34A853" d="M24 24L41.321 14A20 20 0 0 1 24 44Z" />
      <circle cx="24" cy="24" r="11" fill="#fff" />
      <circle cx="24" cy="24" r="8" fill="#4285F4" />
    </svg>
  );
}

function ChromeProfilePicker({
  profiles,
  profilePath,
  disabled,
  onChange,
}: {
  profiles: ChromeCookieProfile[];
  profilePath: string;
  disabled?: boolean;
  onChange: (profilePath: string) => void;
}) {
  const selected = profiles.find(profile => profile.profilePath === profilePath);
  return <Menu.Root>
    <Menu.Trigger asChild>
      <button type="button" aria-label="Chrome profile" disabled={disabled || profiles.length === 0} className="settings-control flex h-auto min-h-9 w-full items-center gap-2.5 py-2 text-left">
        <ChromeMark className="h-5 w-5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{selected ? profileLabel(selected) : 'No Chrome profiles found'}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
      </button>
    </Menu.Trigger>
    <Menu.Portal><Menu.Content align="start" sideOffset={6} className="max-h-64 max-w-[calc(100vw-48px)] overflow-y-auto">
      {profiles.map(profile => <Menu.Item key={profile.profilePath} onSelect={() => onChange(profile.profilePath)}>
        <ChromeMark className="mr-2 h-5 w-5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{profileLabel(profile)}{profile.hasCookies ? '' : ' (no cookies)'}</span>
        <Check className={`ml-3 h-3.5 w-3.5 shrink-0 ${profile.profilePath === profilePath ? '' : 'invisible'}`} />
      </Menu.Item>)}
    </Menu.Content></Menu.Portal>
  </Menu.Root>;
}

function ChromeCookieImportSettings() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [importCookies, setImportCookies] = useState(true);
  const [profiles, setProfiles] = useState<ChromeCookieProfile[]>([]);
  const [platformSupported, setPlatformSupported] = useState(true);
  const [chromeRunning, setChromeRunning] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [profilePath, setProfilePath] = useState('');
  const [status, setStatus] = useState<ChromeCookieImportStatus | null>(null);
  const [busy, setBusy] = useState(false);

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

  const openImportDialog = useCallback(() => {
    setImportCookies(true);
    setDialogOpen(true);
    void refreshProfiles();
  }, [refreshProfiles]);

  const importSelected = useCallback(async () => {
    if (!importCookies) {
      toast.error('Turn on Cookies to import login data.');
      return;
    }
    if (!profilePath) {
      toast.error('Select a Chrome profile first.');
      return;
    }
    setBusy(true);
    try {
      const result = await window.electron.importChromeCookies({ profilePath });
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
  }, [importCookies, profilePath, refreshProfiles]);

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

  const canImport = platformSupported && importCookies && !busy && Boolean(profilePath);

  return (
    <>
      <SettingsGroup title="Browser data">
        <SettingsRow variant="card" label="Import from Chrome" description={!platformSupported ? 'Chrome cookie import is available on macOS.' : undefined}>
          <button type="button" onClick={openImportDialog} disabled={!platformSupported || busy} className="settings-button">Import…</button>
        </SettingsRow>
        <SettingsRow variant="card" label="Imported cookies" description={status?.importedAt ? `${status.cookieCount} cookies · ${status.domains.length} sites${status.profileName ? ` · ${status.profileName}` : ''}` : undefined}>
          {status?.importedAt ? <button type="button" onClick={() => void clearImported()} disabled={busy} className="settings-button">Clear</button> : <span className="text-[var(--text-muted)]">None</span>}
        </SettingsRow>
      </SettingsGroup>

      <Dialog.Root open={dialogOpen} onOpenChange={open => { if (!busy) setDialogOpen(open); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[80] bg-black/35 backdrop-blur-[2px]" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-[81] w-[min(440px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[20px] border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_24px_80px_rgba(0,0,0,0.22)]">
            <div className="px-5 pt-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <Dialog.Title className="text-[16px] font-semibold text-[var(--text-primary)]">
                    Import from browser
                  </Dialog.Title>
                  <Dialog.Description className="mt-1 text-[13px] leading-5 text-[var(--text-muted)]">
                    Copy login cookies into the built-in browser. Imported sites still require permission for agent access.
                  </Dialog.Description>
                </div>
                <Dialog.Close
                  disabled={busy}
                  className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-50"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </Dialog.Close>
              </div>

              <label className="mt-4 block text-[12px] font-medium text-[var(--text-muted)]">From</label>
              <div className="mt-1.5">
                <ChromeProfilePicker
                  profiles={profiles}
                  profilePath={profilePath}
                  disabled={busy}
                  onChange={setProfilePath}
                />
              </div>

              {listError ? <p className="mt-2 text-[12px] leading-5 text-[var(--text-muted)]">{listError}</p> : null}
              <p className="mt-2 text-[12px] leading-5 text-[var(--text-muted)]">
                {chromeRunning
                  ? 'Keep Chrome open and signed in. Quitting drops session cookies.'
                  : 'Open Chrome and sign in first if you need Google session cookies.'}
              </p>

              <div className="mt-4 overflow-hidden rounded-xl border border-[var(--border)]">
                <div className="flex items-center gap-3 px-3 py-2.5">
                  <Cookie className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                  <span className="min-w-0 flex-1 text-[13px] text-[var(--text-primary)]">Cookies</span>
                  <SettingsToggle
                    checked={importCookies}
                    onChange={setImportCookies}
                    disabled={busy}
                    ariaLabel="Import cookies"
                  />
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-4">
              <button
                type="button"
                onClick={() => setDialogOpen(false)}
                disabled={busy}
                className="settings-button"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void importSelected()}
                disabled={!canImport}
                className="settings-primary-button"
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

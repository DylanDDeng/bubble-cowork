import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import * as Dialog from '@/ui/components/ui/dialog';
import { ChevronDown, Cookie, X } from '../icons';
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

  return (
    <>
    <SettingsGroup title="Agent browsing">
      {!settings ? (
        <div className="px-4 py-2.5 text-[13px] text-[var(--text-muted)]">Loading…</div>
      ) : (
        <SettingsRow
          variant="card"
          label="Enable Browser Use"
          description="Let agents use the built-in browser."
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
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = profiles.find((profile) => profile.profilePath === profilePath);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled || profiles.length === 0}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2.5 text-left text-[13px] text-[var(--text-primary)] outline-none disabled:opacity-50"
      >
        <ChromeMark className="h-5 w-5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {selected ? profileLabel(selected) : profiles.length === 0 ? 'No Chrome profiles found' : 'Select a Chrome profile'}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
      </button>
      {open && profiles.length > 0 ? (
        <div className="absolute z-10 mt-1 max-h-48 w-full overflow-auto rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] py-1 shadow-[0_8px_24px_rgba(0,0,0,0.12)]">
          {profiles.map((profile) => (
            <button
              key={profile.profilePath}
              type="button"
              onClick={() => {
                onChange(profile.profilePath);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] hover:bg-[var(--bg-tertiary)] ${
                profile.profilePath === profilePath ? 'text-[var(--text-primary)]' : 'text-[var(--text-primary)]'
              }`}
            >
              <ChromeMark className="h-5 w-5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                {profileLabel(profile)}
                {profile.hasCookies ? '' : ' (no cookies)'}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
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
          <Dialog.Content className="fixed left-1/2 top-1/2 z-[81] w-[min(440px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[20px] border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_24px_80px_rgba(0,0,0,0.22)]">
            <div className="px-5 pt-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <Dialog.Title className="text-[16px] font-semibold text-[var(--text-primary)]">
                    Import from browser
                  </Dialog.Title>
                  <Dialog.Description className="mt-1 text-[13px] leading-5 text-[var(--text-muted)]">
                    Select cookies to copy into the built-in browser.
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

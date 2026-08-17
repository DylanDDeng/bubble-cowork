import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ChevronDown, Eye, EyeOff } from '../icons';
import type { DeepseekKeyStatus } from '../../types';
import { DeepseekLogo } from '../DeepseekLogo';
import { SettingsGroup } from './SettingsPrimitives';

/**
 * API-key management for the DeepSeek Harness agent, visually mirroring the
 * Bubble provider rows. Shows the effective key and where it came from — a
 * locally saved key, the env var, or the installed dsh CLI's credential file
 * (read-only import).
 */
export function DeepseekProviderSettings() {
  const [status, setStatus] = useState<DeepseekKeyStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.electron
      .getDeepseekKeyStatus()
      .then((next) => {
        if (!cancelled) {
          setStatus(next);
          setLoadError(null);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleExpanded = useCallback(() => {
    setExpanded((current) => !current);
    setKeyDraft('');
    setShowKey(false);
  }, []);

  // Prefill the editor with the effective key when one exists, so the user
  // sees it masked (dots) and can reveal it with the eye toggle — the same
  // "saved credential" pattern as Bubble. Fetched on demand; the bulk status
  // never carries keys. A prefilled env/dsh key lets the user pin it into the
  // Aegis store by pressing Save.
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    window.electron
      .getDeepseekApiKey()
      .then((key) => {
        if (!cancelled && key) setKeyDraft(key);
      })
      .catch(() => {
        // Leave the draft empty; the user can still type a key.
      });
    return () => {
      cancelled = true;
    };
  }, [expanded]);

  const saveKey = async () => {
    if (!keyDraft.trim()) {
      toast.error('Enter an API key first.');
      return;
    }
    setBusy(true);
    try {
      setStatus(await window.electron.setDeepseekApiKey(keyDraft));
      setExpanded(false);
      setKeyDraft('');
      toast.success('Saved DeepSeek API key.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save the key.');
    } finally {
      setBusy(false);
    }
  };

  const clearKey = async () => {
    setBusy(true);
    try {
      setStatus(await window.electron.clearDeepseekApiKey());
      setExpanded(false);
      setKeyDraft('');
      toast.success('Removed the Aegis-stored DeepSeek API key.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to remove the key.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsGroup title="DeepSeek Harness">
      {loadError ? (
        <div className="px-4 py-3 text-[13px] text-[var(--text-muted)]">
          Could not load DeepSeek key status: {loadError}
        </div>
      ) : !status ? (
        <div className="px-4 py-3 text-[13px] text-[var(--text-muted)]">Loading…</div>
      ) : (
        <>
          <div className="px-4 py-3">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4">
              <div className="flex min-w-0 items-center gap-2.5">
                <DeepseekLogo />
                <div className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-[var(--text-primary)]">
                  <span className="truncate">DeepSeek API Key</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={toggleExpanded}
                  disabled={busy}
                  aria-expanded={expanded}
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-50"
                >
                  <span>{status.hasApiKey ? 'Edit key' : 'Add key'}</span>
                  <ChevronDown
                    className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
                  />
                </button>
                {status.keySource === 'aegis' ? (
                  <button
                    type="button"
                    onClick={() => void clearKey()}
                    disabled={busy}
                    className="rounded-lg px-2 py-1 text-[12px] font-medium text-red-500 transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            </div>

            {expanded ? (
              <div className="mt-3 flex items-center gap-2">
                <div className="relative min-w-0 flex-1">
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={keyDraft}
                    onChange={(event) => setKeyDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void saveKey();
                    }}
                    placeholder={status.hasApiKey ? 'Enter a new API key to replace' : 'sk-...'}
                    autoFocus
                    disabled={busy}
                    className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] py-1.5 pl-3 pr-8 font-mono text-[12px] text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--text-muted)] disabled:opacity-50"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((current) => !current)}
                    className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
                    aria-label={showKey ? 'Hide key' : 'Show key'}
                    disabled={busy}
                  >
                    {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => void saveKey()}
                  disabled={busy || !keyDraft.trim()}
                  className="rounded-lg bg-[var(--text-primary)] px-3 py-1.5 text-[12px] font-medium text-[var(--bg-primary)] transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  Save
                </button>
              </div>
            ) : null}
          </div>
        </>
      )}
    </SettingsGroup>
  );
}

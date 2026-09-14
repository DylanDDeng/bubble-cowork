import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { DeepseekKeyStatus } from '../../types';
import { DeepseekLogo } from '../DeepseekLogo';
import { ProviderKeyEditor, ProviderSettingsRow, ProviderSettingsSection } from './ProviderSettingsPrimitives';

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
  const keyEdited = useRef(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

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
  }, [loadAttempt]);

  const toggleExpanded = useCallback(() => {
    setExpanded((current) => !current);
    setKeyDraft('');
    keyEdited.current = false;
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
        if (!cancelled && !keyEdited.current && key) setKeyDraft(key);
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

  return <ProviderSettingsSection title="DeepSeek Harness">
    {loadError ? <div className="provider-load-message" role="alert">Could not load key status. <button onClick={() => { setLoadError(null); setLoadAttempt(value => value + 1); }}>Retry</button></div>
      : !status ? <div className="provider-load-message" role="status">Loading…</div>
      : <ProviderSettingsRow label="DeepSeek" scope="DeepSeek Harness" logo={<DeepseekLogo />} expanded={expanded} disabled={busy} onToggleExpand={toggleExpanded}
        status={!status.hasApiKey ? 'No API key' : status.keySource === 'aegis' ? 'Configured' : 'Using existing key'}
        actions={status.keySource === 'aegis' ? [{ label: 'Remove saved key', onSelect: () => void clearKey(), destructive: true }] : []}>
        <ProviderKeyEditor label="DeepSeek API key for DeepSeek Harness" value={keyDraft} onChange={value => { keyEdited.current = true; setKeyDraft(value); }} showKey={showKey} onToggleVisibility={() => setShowKey(value => !value)} busy={busy} onSave={() => void saveKey()} onCancel={toggleExpanded} />
      </ProviderSettingsRow>}
  </ProviderSettingsSection>;
}

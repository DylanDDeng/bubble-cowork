import { useEffect, useRef, useState } from 'react';
import * as Dialog from '../ui/dialog';
import { ChevronDown, Copy, Monitor, X } from '../icons';
import { SettingsToggle } from './SettingsPrimitives';
import type { RemoteEnvironment } from '../../../shared/remote/protocol';
import './remote-companion-settings.css';

interface Status {
  status: string;
  enabled: boolean;
  environment: RemoteEnvironment;
  relay: string;
  /** The public Aegis relay, used unless a custom relay is set. */
  defaultRelay?: string;
  relayError?: string;
  projects: { id: string; name: string }[];
  devices: { peerId: string; name: string; push?: unknown }[];
}
interface Pairing { url: string; qr: string; expiresAt: number }
const statusLabels: Record<string, string> = {
  disabled: 'Off', connecting: 'Connecting…', waiting: 'Ready to connect',
  connected: 'Connected', offline: 'Reconnecting…', rejected: 'Relay refused this Mac',
};

export function RemoteCompanionSettings() {
  const [status, setStatus] = useState<Status>();
  const [relay, setRelay] = useState('');
  const [token, setToken] = useState('');
  const [pair, setPair] = useState<Pairing>();
  const [dialog, setDialog] = useState<'setup' | 'pair' | null>(null);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);
  const [retry, setRetry] = useState(0);
  const revision = useRef(0);
  const mutating = useRef(false);
  const alive = useRef(true);
  const pairedDevices = useRef<string[]>([]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; revision.current++; };
  }, []);
  useEffect(() => {
    let active = true;
    let loading = false;
    const load = async () => {
      if (loading || mutating.current) return;
      loading = true;
      const version = revision.current;
      try {
        const next: Status = await window.electron.remoteCompanion('status');
        if (active && version === revision.current) {
          setStatus(next);
          setLoadError('');
        }
      } catch (e) {
        if (active && version === revision.current) setLoadError(e instanceof Error ? e.message : String(e));
      } finally { loading = false; }
    };
    void load();
    const timer = setInterval(load, 2500);
    return () => { active = false; clearInterval(timer); };
  }, [retry]);
  useEffect(() => {
    if (!pair) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pair]);
  useEffect(() => {
    if (pair && status?.devices.some(device => !pairedDevices.current.includes(device.peerId))) {
      setPair(undefined);
      setDialog(null);
    }
  }, [pair, status]);

  const act = async (action: string, payload?: unknown) => {
    if (mutating.current) return;
    mutating.current = true;
    revision.current++;
    setBusy(true);
    setError('');
    try {
      const result = await window.electron.remoteCompanion(action, payload);
      if (!alive.current) return;
      if (action === 'pair') {
        pairedDevices.current = status?.devices.map(device => device.peerId) ?? [];
        setPair(result);
        setCopied(false);
        setDialog('pair');
      } else {
        setStatus(result);
        setPair(undefined);
        setToken('');
        setDialog(null);
      }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      revision.current++;
      mutating.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const openSetup = () => {
    setRelay(status?.relay && status.relay !== status.defaultRelay ? status.relay : '');
    setToken(''); setError(''); setDialog('setup');
  };
  const closeDialog = () => {
    if (busy) return;
    setDialog(null); setPair(undefined); setToken(''); setError(''); setCopied(false);
  };
  const ready = !!status?.enabled && ['waiting', 'connected'].includes(status.status) && !loadError;
  const seconds = pair ? Math.max(0, Math.ceil((pair.expiresAt - now) / 1000)) : 0;
  const copyLink = async () => {
    if (!pair || Date.now() >= pair.expiresAt) return;
    try { await navigator.clipboard.writeText(pair.url); setCopied(true); }
    catch { setError('Could not copy the pairing link. Try again.'); }
  };

  return <div className="connections-settings">
    <section aria-labelledby="connections-devices-title">
      <div className="connections-section-heading">
        <h2 id="connections-devices-title">Devices that can access this Mac</h2>
        {!!status?.devices.length && <button className="settings-button connections-outlined-button" disabled={busy || !ready} onClick={() => void act('pair')}>Add device</button>}
      </div>
      {loadError && <div className="connections-error" role="alert">Could not refresh connections. {loadError} <button className="settings-button" onClick={() => setRetry(value => value + 1)}>Retry</button></div>}
      {error && !dialog && <p className="connections-error" role="alert">{error}</p>}
      {!status ? <p className="connections-empty" role="status">{loadError ? 'Connection status unavailable' : 'Loading connections…'}</p>
        : status.devices.length ? <div className="connections-device-list">
          {status.devices.map(device => <div className="connections-row" key={device.peerId}>
            <div className="connections-device"><span className="connections-phone" aria-hidden="true" /><div><h3>{device.name}</h3><p>{status.enabled ? (device.push ? 'Authorized device · Notifications on' : 'Authorized device') : 'Remote access is off'}</p></div></div>
            <button className="settings-button connections-outlined-button" disabled={busy || !!loadError} onClick={() => void act('revoke', { peerId: device.peerId })}>Revoke access</button>
          </div>)}
        </div> : <div className="connections-empty">
          <div className="connections-device-illustration" aria-hidden="true"><Monitor /><span className="connections-phone" /></div>
          <p>Continue your tasks from your iPhone.</p>
          <button className="settings-primary-button" disabled={busy || !!loadError || (status.enabled && !ready)} onClick={() => status.enabled ? void act('pair') : openSetup()}>{busy ? 'Please wait…' : status.enabled ? 'Add device' : 'Set up'}</button>
        </div>}
      <p className="connections-note">Your iPhone can view conversations, send tasks, and respond to approvals. One phone can be online at a time.</p>
    </section>

    <section aria-labelledby="connections-access-title">
      <h2 id="connections-access-title">Remote access</h2>
      <div className="connections-row">
        <div><h3>Allow connections to this Mac</h3><p>Keep Aegis open and your Mac awake to connect.</p></div>
        <SettingsToggle checked={status?.enabled ?? false} disabled={!status || busy || !!loadError} ariaLabel="Allow connections to this Mac" onChange={enabled => enabled ? openSetup() : void act('disable')} />
      </div>
      <div className="connections-row connections-status-row"><span>Status</span><span className="connections-status" role="status"><i data-online={!loadError && ready} />{loadError ? 'Unavailable' : status ? statusLabels[status.status] ?? 'Unavailable' : 'Loading…'}</span></div>
      {status && <details className="settings-disclosure connections-details">
        <summary><ChevronDown />Connection details</summary>
        <dl>
          <div><dt>Data source</dt><dd>{status.environment === 'development' ? 'Aegis Dev' : 'Aegis'}</dd></div>
          <div><dt>Relay server</dt><dd>{status.relay || status.defaultRelay || 'Not configured'}{status.relayError ? ` · ${status.relayError}` : ''}</dd></div>
        </dl>
        {!status.enabled && !!status.devices.length && <p className="connections-note">Setting up again replaces the previous connection. You’ll need to pair your devices again.</p>}
      </details>}
    </section>

    <Dialog.Root open={dialog !== null} onOpenChange={open => { if (!open) closeDialog(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[80] bg-black/30" />
        <Dialog.Content className="connections-dialog">
          <div className="connections-dialog-header"><Dialog.Title>{dialog === 'setup' ? 'Set up iPhone access' : 'Pair your iPhone'}</Dialog.Title><button className="settings-button" aria-label="Close pairing" disabled={busy} onClick={closeDialog}><X className="h-4 w-4" /></button></div>
          <Dialog.Description className="connections-dialog-description">{dialog === 'setup' ? 'Your iPhone will see all your projects and conversations.' : 'Open Aegis on your iPhone and scan this code. Then approve the connection on this Mac.'}</Dialog.Description>
          {error && <p role="alert" className="connections-error">{error}</p>}
          {dialog === 'setup' && <form onSubmit={event => { event.preventDefault(); void act('configure', { relay: relay.trim(), token: token.trim() }); }}>
            <details className="settings-disclosure connections-details" open={!!relay}>
              <summary><ChevronDown />Custom relay</summary>
              <p className="connections-note">Leave empty to use the Aegis relay. It only forwards end-to-end encrypted data.</p>
              <label className="connections-field">Relay server<input className="settings-control" type="url" placeholder={status?.defaultRelay ?? 'wss://relay.example.com'} value={relay} onChange={event => setRelay(event.target.value)} disabled={busy} /></label>
              <label className="connections-field">Registration token (optional)<input className="settings-control" type="password" autoComplete="off" minLength={32} maxLength={128} value={token} onChange={event => setToken(event.target.value)} disabled={busy || !relay.trim()} /></label>
            </details>
            {!!status?.devices.length && <p className="connections-note">This replaces your previous connection. Existing devices will need to pair again.</p>}
            <div className="connections-dialog-actions"><button type="button" className="settings-button" disabled={busy} onClick={closeDialog}>Cancel</button><button className="settings-primary-button" disabled={busy || (!!token.trim() && token.trim().length < 32)}>{busy ? 'Connecting…' : 'Enable access'}</button></div>
          </form>}
          {dialog === 'pair' && pair && <>
            <div className="connections-qr">{seconds > 0 ? <img src={pair.qr} width={220} height={220} alt="Scan to pair your iPhone" /> : <div className="connections-expired"><Monitor /><p>Pairing code expired</p><button className="settings-primary-button" disabled={busy || !ready} onClick={() => void act('pair')}>Generate new code</button></div>}</div>
            <p className="connections-pair-expiry">{seconds > 0 ? `Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} · Single use` : 'Generate a new code to continue.'}</p>
            <div className="connections-dialog-actions"><button className="settings-button" disabled={!seconds || busy} onClick={() => void copyLink()}><Copy className="h-3.5 w-3.5" />{copied ? 'Copied' : 'Copy pairing link'}</button><button className="settings-primary-button" onClick={closeDialog}>Done</button></div>
          </>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </div>;
}

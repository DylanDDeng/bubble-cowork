import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import * as Dialog from '../ui/dialog';
import { ChevronDown, FolderOpen, X } from '../icons';
import { PreferenceSelect } from './GeneralSettingsContent';
import type { FeishuStatus } from '../../types';
import { SettingsGroup, SettingsRow, SettingsToggle } from './SettingsPrimitives';

const CONNECTION_LABELS: Record<FeishuStatus['connection'], string> = {
  off: 'Off',
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  error: 'Not connected',
};

export function BridgeSettingsContent() {
  const [status, setStatus] = useState<FeishuStatus>();
  const [loadError, setLoadError] = useState('');
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [domain, setDomain] = useState<'feishu' | 'lark'>('feishu');
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const next = await window.electron.feishu('status');
        if (!active) return;
        setStatus(next);
        setLoadError('');
      } catch (error) {
        if (active) setLoadError(error instanceof Error ? error.message : String(error));
      }
    };
    void load();
    const timer = window.setInterval(load, qrOpen ? 1500 : 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [retry, qrOpen]);
  useEffect(() => {
    if (!qrOpen) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [qrOpen]);
  // Scanning finished: the bot is configured and no registration is pending.
  useEffect(() => {
    if (qrOpen && status?.configured && !status.registration) {
      setQrOpen(false);
      toast.success('Feishu bot connected.');
    }
  }, [qrOpen, status]);

  const act = async (action: string, payload?: Record<string, unknown>, success?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await window.electron.feishu(action, payload);
      if (!alive.current) return;
      setStatus(next);
      if (success) toast.success(success);
      return next;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const startQr = async () => {
    setQrOpen(true);
    await act('register', { domain });
  };
  const cancelQr = () => {
    setQrOpen(false);
    void act('cancel-register');
  };
  const pickProject = async () => {
    const selected = await window.electron.selectDirectory().catch(() => null);
    if (selected) await act('set-default-cwd', { cwd: selected });
  };

  if (loadError && !status) {
    return <div role="alert" className="text-[13px]">Could not load Feishu settings. <button className="settings-button" onClick={() => setRetry(v => v + 1)}>Retry</button></div>;
  }
  if (!status) return <div className="px-1 py-2 text-[12.5px] text-[var(--text-muted)]">Loading Feishu settings…</div>;

  const connected = status.connection === 'connected';
  const registration = status.registration;
  const seconds = registration?.expiresAt ? Math.max(0, Math.ceil((registration.expiresAt - now) / 1000)) : 0;
  const projectOptions = [
    ...(status.defaultCwd && !status.projects.some(p => p.path === status.defaultCwd) ? [{ value: status.defaultCwd, label: status.defaultCwd.split('/').pop() || status.defaultCwd }] : []),
    ...status.projects.map(p => ({ value: p.path, label: p.name })),
  ];

  return (
    <div className="space-y-7 pb-8">
      <SettingsGroup title="Connection" description="Chat with your Aegis agents from Feishu or Lark. Each chat or topic runs its own task on this Mac.">
        {!status.configured ? (
          <SettingsRow variant="card" label="Connect a bot" description="Scan with Feishu to create a bot for Aegis. Only you can use it until you invite others.">
            <button type="button" className="settings-primary-button" disabled={busy} onClick={() => void startQr()}>Connect with Feishu</button>
          </SettingsRow>
        ) : (
          <>
            <SettingsRow variant="card" label="Status" description={status.connection === 'error' ? status.error : status.botName ? `Bot: ${status.botName}` : undefined}>
              <span className="inline-flex items-center gap-2 text-[12px] font-medium" role="status">
                <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-[var(--success)]' : status.connection === 'error' ? 'bg-[var(--error)]' : 'bg-[var(--text-muted)]'}`} aria-hidden="true" />
                {CONNECTION_LABELS[status.connection]}
                {status.enabled && !connected && status.connection !== 'connecting' && <button type="button" className="settings-button" disabled={busy} onClick={() => void act('reconnect')}>Reconnect</button>}
              </span>
            </SettingsRow>
            <SettingsRow variant="card" label="Allow messages from Feishu" description="Keep Aegis open and your Mac awake to receive them.">
              <SettingsToggle checked={status.enabled} disabled={busy} ariaLabel="Allow messages from Feishu" onChange={enabled => void act('set-enabled', { enabled })} />
            </SettingsRow>
            {!status.hasOwner && status.claimCode && (
              <SettingsRow variant="card" label="Claim this bot" description={`Send /claim ${status.claimCode} to the bot in a direct message to become its owner.`}>
                <code className="text-[13px] font-medium">{status.claimCode}</code>
              </SettingsRow>
            )}
            <SettingsRow variant="card" label="App" description={`${status.domain === 'lark' ? 'Lark' : 'Feishu'} · ${status.appId ?? ''}`}>
              <button type="button" className="settings-button" disabled={busy} onClick={() => void act('forget', undefined, 'Feishu bot disconnected.')}>Disconnect</button>
            </SettingsRow>
          </>
        )}
      </SettingsGroup>

      <SettingsGroup title="New tasks" description="Agent and permissions follow your Aegis defaults. A chat can change them with /agent, or pick another project with /project.">
        <SettingsRow variant="card" label="Default project">
          <div className="flex items-center gap-2">
            <PreferenceSelect label="Default project" value={status.defaultCwd ?? ''} options={projectOptions} disabled={busy || !projectOptions.length} onChange={cwd => void act('set-default-cwd', { cwd })} />
            <button type="button" className="settings-button" aria-label="Choose a folder" disabled={busy} onClick={() => void pickProject()}><FolderOpen className="h-3.5 w-3.5" /></button>
          </div>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Who can use it" description="The bot owner always can. Invite others from Feishu with /invite @name, or /invite group in a group.">
        {!status.allowedUsers.length && !status.allowedChats.length ? (
          <SettingsRow variant="card" label="Only you" description={status.hasOwner ? 'Nobody else can use the bot yet.' : 'Claim the bot to become its owner.'}><span /></SettingsRow>
        ) : null}
        {status.allowedUsers.map(user => (
          <SettingsRow key={user.openId} variant="card" label={user.name || 'Feishu user'} description={user.openId}>
            <button type="button" className="settings-button" disabled={busy} onClick={() => void act('remove-user', { openId: user.openId })}>Remove</button>
          </SettingsRow>
        ))}
        {status.allowedChats.map(chat => (
          <SettingsRow key={chat.chatId} variant="card" label={chat.name || 'Feishu group'} description="Everyone in this group">
            <button type="button" className="settings-button" disabled={busy} onClick={() => void act('remove-chat', { chatId: chat.chatId })}>Remove</button>
          </SettingsRow>
        ))}
      </SettingsGroup>

      {status.bindings.length > 0 && (
        <SettingsGroup title="Chats with a task" description="Messages in these chats continue the task. Disconnecting makes the next message start a new one.">
          {status.bindings.map(binding => (
            <SettingsRow key={binding.scope} variant="card" label={binding.title} description={binding.topic ? 'Topic' : 'Chat'}>
              <button type="button" className="settings-button" disabled={busy} onClick={() => void act('unbind', { scope: binding.scope })}>Disconnect</button>
            </SettingsRow>
          ))}
        </SettingsGroup>
      )}

      <details className="settings-disclosure">
        <summary><ChevronDown />Use an existing app</summary>
        <form className="space-y-3 pt-2" onSubmit={event => { event.preventDefault(); void act('save-credentials', { appId, appSecret, domain }, 'Saved. Connecting…').then(next => { if (next) setAppSecret(''); }); }}>
          <p className="text-[12px] leading-5 text-[var(--text-muted)]">For an app you created in the Feishu or Lark developer console. It needs bot messaging, card and long-connection event permissions.</p>
          <label className="settings-form-field"><span className="text-[13px] font-medium">Platform</span>
            <PreferenceSelect label="Platform" value={domain} options={[{ value: 'feishu', label: 'Feishu' }, { value: 'lark', label: 'Lark' }]} onChange={value => setDomain(value as 'feishu' | 'lark')} />
          </label>
          <label className="settings-form-field" data-settings-label="App ID"><span className="text-[13px] font-medium">App ID</span>
            <input className="settings-control w-full" aria-label="App ID" placeholder="cli_xxxxxxxxxxxx" value={appId} onChange={event => setAppId(event.target.value)} disabled={busy} />
          </label>
          <label className="settings-form-field"><span className="text-[13px] font-medium">App Secret</span>
            <input className="settings-control w-full" type="password" autoComplete="off" aria-label="App Secret" value={appSecret} onChange={event => setAppSecret(event.target.value)} disabled={busy} />
          </label>
          <div className="flex justify-end"><button className="settings-primary-button" disabled={busy || !appId.trim() || !appSecret.trim()}>Save and connect</button></div>
        </form>
      </details>

      <Dialog.Root open={qrOpen} onOpenChange={open => { if (!open) cancelQr(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[80] bg-black/30" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-[81] w-[380px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] p-5 shadow-[0_18px_44px_rgba(15,23,42,0.18)]">
            <div className="flex items-center justify-between"><Dialog.Title className="text-[15px] font-semibold">Connect with Feishu</Dialog.Title><button className="settings-button" aria-label="Close" onClick={cancelQr}><X className="h-4 w-4" /></button></div>
            <Dialog.Description className="mt-1 text-[12.5px] leading-5 text-[var(--text-muted)]">Scan with the Feishu or Lark app on your phone. It creates a bot for Aegis in your workspace.</Dialog.Description>
            {registration?.state === 'error' ? (
              <p role="alert" className="mt-4 text-[12.5px] text-[var(--error)]">{registration.error || 'Setup failed.'} <button className="settings-button" onClick={() => void startQr()}>Try again</button></p>
            ) : (
              <>
                <div className="mt-4 flex h-[236px] items-center justify-center rounded-xl bg-white">{registration?.qr && seconds > 0 ? <img src={registration.qr} width={220} height={220} alt="Scan to create the Feishu bot" /> : <p className="text-[13px] text-[var(--text-muted)]">{registration?.qr ? 'Code expired.' : 'Preparing code…'}</p>}</div>
                <p className="mt-3 text-center text-[12px] text-[var(--text-muted)]">{seconds > 0 ? `Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : registration?.qr ? <button className="settings-button" onClick={() => void startQr()}>Generate new code</button> : null}</p>
              </>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

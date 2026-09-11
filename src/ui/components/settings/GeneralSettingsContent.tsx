import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Check, ChevronDown } from '../icons';
import * as DropdownMenu from '../ui/dropdown-menu';
import type { AppPreferences } from '../../../shared/app-preferences';
import { useAppPreferences, saveAppPreferences, subscribeAppPreferences, refreshAppPreferences } from '../../store/useAppPreferences';
import { useAppStore } from '../../store/useAppStore';
import { SettingsGroup, SettingsRow, SettingsToggle } from './SettingsPrimitives';
import { ApplicationDestinationSelect, type ApplicationDestinationOption } from './ApplicationDestinationSelect';

const selectClass = 'h-8 max-w-full min-w-0 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-2 text-[13px] text-[var(--text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]';

export function PreferenceSelect({ label, value, options, disabled, onChange }: {
  label: string; value: string; options: { value: string; label: string }[]; disabled?: boolean; onChange: (value: string) => void;
}) {
  const selected = options.find(option => option.value === value);
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>
      <button type="button" aria-label={label} data-preference-value={value} disabled={disabled} className={`${selectClass} inline-flex items-center gap-2 disabled:opacity-50`}>
        <span className="truncate">{selected?.label || (disabled ? 'Loading…' : 'Unavailable')}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content align="end" sideOffset={6} className="max-w-[calc(100vw-24px)]">
      {options.map(option => <DropdownMenu.Item key={option.value} data-preference-option={option.value} onSelect={() => onChange(option.value)} className="gap-3 text-[13px]">
        <span className="min-w-0 flex-1">{option.label}</span>
        <Check aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 ${value === option.value ? '' : 'invisible'}`} />
      </DropdownMenu.Item>)}
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>;
}

export function GeneralSettingsContent() {
  const preferences = useAppPreferences();
  const modifier = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
  const [editors, setEditors] = useState<ApplicationDestinationOption[]>([]);
  const [shells, setShells] = useState<{ value: string; label: string }[]>([]);
  const [notifications, setNotifications] = useState<Awaited<ReturnType<Window['electron']['getNotificationSettings']>> | null>(null);
  const [version, setVersion] = useState('');
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const updateStatus = useAppStore(s => s.updateStatus);
  useEffect(subscribeAppPreferences, []);
  useEffect(() => {
    let alive = true;
    setError(''); setLoaded(false);
    void Promise.all([
      window.electron.getEnvironmentEditorLaunchers(), window.electron.getTerminalShellOptions(),
      window.electron.getNotificationSettings(), window.electron.getAppVersion(), refreshAppPreferences(),
    ]).then(([targets, availableShells, alerts, appVersion]) => {
      if (!alive) return;
      setEditors(targets.filter(target => target.available).map(target => ({ value: target.id, label: target.label, iconDataUrl: target.iconDataUrl })));
      setShells(availableShells); setNotifications(alerts); setVersion(appVersion); setLoaded(true);
    }).catch(error => { if (alive) setError(error instanceof Error ? error.message : String(error)); });
    return () => { alive = false; };
  }, [retry]);

  const save = async (patch: Partial<AppPreferences>) => {
    setSaving(true);
    try { await saveAppPreferences(patch); }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Could not save preference.'); }
    finally { setSaving(false); }
  };
  const saveNotifications = async (patch: Parameters<Window['electron']['setNotificationSettings']>[0]) => {
    setSaving(true);
    try { setNotifications(await window.electron.setNotificationSettings(patch)); }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Could not save notifications.'); }
    finally { setSaving(false); }
  };
  const disabled = !loaded || saving;
  const completion = notifications?.enabled ? notifications.onlyWhenUnfocused ? 'unfocused' : 'always' : 'off';
  const toggle = (key: 'preventSleep' | 'showContextUsage' | 'plainTextComposer', label: string) => <SettingsToggle ariaLabel={label} checked={preferences[key]} disabled={disabled} onChange={value => void save({ [key]: value })} />;
  return <div className="space-y-8 pb-8">
    {error && <div role="alert" className="text-[13px] text-[var(--error)]">Could not load preferences: {error} <button className="underline" onClick={() => setRetry(value => value + 1)}>Retry</button></div>}
    <SettingsGroup title="General">
      <SettingsRow variant="card" label="Default open destination" description="Where project folders open by default.">
        <ApplicationDestinationSelect label="Default open destination" value={preferences.defaultEditor} options={editors} disabled={disabled} onChange={value => void save({ defaultEditor: value })} />
      </SettingsRow>
      <SettingsRow variant="card" label="Terminal shell" description="Used when opening a new integrated terminal.">
        <PreferenceSelect label="Terminal shell" value={preferences.terminalShell} options={shells} disabled={disabled} onChange={value => void save({ terminalShell: value })} />
      </SettingsRow>
      <SettingsRow variant="card" label="Prevent sleep while running" description="Keep your computer awake while Aegis runs a task.">{toggle('preventSleep', 'Prevent sleep while running')}</SettingsRow>
    </SettingsGroup>
    <SettingsGroup title="Composer">
      <SettingsRow variant="card" label="Plain text input" description="Keep links as literal text while writing messages.">{toggle('plainTextComposer', 'Plain text input')}</SettingsRow>
      <SettingsRow variant="card" label="Show context usage">{toggle('showContextUsage', 'Show context usage')}</SettingsRow>
      <SettingsRow variant="card" label="Send with">
        <PreferenceSelect label="Send with" value={preferences.enterBehavior} disabled={disabled} onChange={value => void save({ enterBehavior: value as AppPreferences['enterBehavior'] })} options={[
          { value: 'enter', label: 'Enter' }, { value: 'multiline', label: `${modifier} + Enter for multiline` }, { value: 'modifier', label: `${modifier} + Enter always` },
        ]} />
      </SettingsRow>
      <SettingsRow variant="card" label="Follow-up behavior" description={`Queue follow-ups or steer the current run. ${modifier}${preferences.enterBehavior === 'enter' ? '' : ' + Shift'} + Enter does the opposite.`}>
        <PreferenceSelect label="Follow-up behavior" value={preferences.followUpBehavior} disabled={disabled} onChange={value => void save({ followUpBehavior: value as AppPreferences['followUpBehavior'] })} options={[{ value: 'queue', label: 'Queue' }, { value: 'steer', label: 'Steer' }]} />
      </SettingsRow>
    </SettingsGroup>
    <SettingsGroup title="Notifications">
      <SettingsRow variant="card" label="Task completed">
        <PreferenceSelect label="Task completed" value={completion} disabled={disabled} options={[{ value: 'off', label: 'Off' }, { value: 'unfocused', label: 'When in background' }, { value: 'always', label: 'Always' }]} onChange={value => void saveNotifications({ enabled: value !== 'off', onlyWhenUnfocused: value !== 'always' })} />
      </SettingsRow>
      <SettingsRow variant="card" label="Input required" description="Notify when Aegis is in the background."><SettingsToggle ariaLabel="Input required" checked={notifications?.inputRequired ?? true} disabled={disabled} onChange={value => void saveNotifications({ inputRequired: value })} /></SettingsRow>
      <SettingsRow variant="card" label="Approval required" description="Notify when Aegis is in the background."><SettingsToggle ariaLabel="Approval required" checked={notifications?.approvalRequired ?? true} disabled={disabled} onChange={value => void saveNotifications({ approvalRequired: value })} /></SettingsRow>
    </SettingsGroup>
    <SettingsGroup title="Application">
      <SettingsRow variant="card" label="Updates" description={version ? `Version ${version}${updateStatus.available ? ` · ${updateStatus.version || 'Update'} available` : ''}` : 'Loading version…'}>
        <button className={selectClass} disabled={checking} onClick={async () => {
          setChecking(true);
          try { await window.electron.checkForUpdates(); }
          catch (error) { toast.error(error instanceof Error ? error.message : 'Could not check for updates.'); }
          finally { setChecking(false); }
        }}>{checking ? 'Checking…' : 'Check for updates'}</button>
      </SettingsRow>
    </SettingsGroup>
  </div>;
}

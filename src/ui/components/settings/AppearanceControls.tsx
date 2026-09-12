import { toast } from 'sonner';
import type { AppPreferences } from '../../../shared/app-preferences';
import { useAppPreferences, saveAppPreferences } from '../../store/useAppPreferences';
import { PreferenceSelect } from './GeneralSettingsContent';
import { SettingsGroup, SettingsRow, SettingsToggle } from './SettingsPrimitives';

export function AppearanceControls() {
  const prefs = useAppPreferences();
  const save = (patch: Partial<AppPreferences>) => { void saveAppPreferences(patch).catch(error => toast.error(error instanceof Error ? error.message : 'Could not save appearance.')); };
  const size = (key: 'uiFontSize' | 'codeFontSize', label: string) => {
    const commit = (input: HTMLInputElement) => {
      const value = Number(input.value);
      if (!input.value || !Number.isInteger(value) || value < 10 || value > 24) { input.value = String(prefs[key]); return; }
      if (value !== prefs[key]) save({ [key]: value });
    };
    return <div className="flex items-center gap-2"><input key={prefs[key]} type="number" min={10} max={24} step={1} aria-label={label} defaultValue={prefs[key]}
      onBlur={e => commit(e.currentTarget)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(e.currentTarget); } }}
      className="h-8 w-16 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]" /><span className="text-[13px] text-[var(--text-muted)]">px</span></div>;
  };
  return <>
    <SettingsGroup title="Typography">
      <SettingsRow variant="card" label="UI font size">{size('uiFontSize', 'UI font size')}</SettingsRow>
      <SettingsRow variant="card" label="Code font size">{size('codeFontSize', 'Code font size')}</SettingsRow>
      {/Mac/.test(navigator.platform) && <SettingsRow variant="card" label="Font smoothing"><SettingsToggle ariaLabel="Font smoothing" checked={prefs.fontSmoothing} onChange={value => save({fontSmoothing: value})} /></SettingsRow>}
    </SettingsGroup>
    <SettingsGroup title="Interaction">
      <SettingsRow variant="card" label="Use pointer cursors"><SettingsToggle ariaLabel="Use pointer cursors" checked={prefs.pointerCursors} onChange={value => save({pointerCursors: value})} /></SettingsRow>
      <SettingsRow variant="card" label="Diff markers"><PreferenceSelect label="Diff markers" value={prefs.diffMarkers} onChange={value => save({diffMarkers: value as AppPreferences['diffMarkers']})} options={[{value:'color',label:'Color'}, {value:'signs',label:'+ / −'}]} /></SettingsRow>
      <SettingsRow variant="card" label="Reduce motion"><PreferenceSelect label="Reduce motion" value={prefs.reduceMotion} onChange={value => save({reduceMotion: value as AppPreferences['reduceMotion']})} options={[{value:'system',label:'System'}, {value:'on',label:'On'}, {value:'off',label:'Off'}]} /></SettingsRow>
    </SettingsGroup>
  </>;
}

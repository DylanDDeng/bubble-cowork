import { useId, type ReactNode } from 'react';
import { ChevronDown, Eye, EyeOff, MoreHorizontal } from '../icons';
import * as Menu from '../ui/dropdown-menu';
import { SettingsToggle } from './SettingsPrimitives';
import './provider-settings.css';

export function ProviderSettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="provider-settings-section" aria-label={title} data-settings-label={title}>
    <h2>{title}</h2><div className="provider-settings-card">{children}</div>
  </section>;
}
export function ProviderSettingsRow({ label, scope, logo, status, isDefault, expanded, disabled, enabled, onToggleEnabled, onToggleExpand, actions = [], children }: {
  label: string; scope: string; logo: ReactNode; status?: string; isDefault?: boolean; expanded: boolean; disabled?: boolean;
  enabled?: boolean; onToggleEnabled?: (next: boolean) => void; onToggleExpand: () => void;
  actions?: {label: string; onSelect: () => void; destructive?: boolean}[]; children?: ReactNode;
}) {
  const id = useId();
  return <div className="provider-settings-item" data-settings-id={`${scope}:${label}`}>
    <div className="provider-settings-row">
      <button type="button" className="provider-settings-expand" aria-label={`${scope}: ${label}`} aria-expanded={expanded} aria-controls={id} disabled={disabled} onClick={onToggleExpand}>
        <span className="provider-settings-logo">{logo}</span><span className="provider-settings-name">{label}</span>
        {isDefault && <span className="provider-settings-status">Default</span>}
        {status && <span className="provider-settings-status">{status}</span>}
        <ChevronDown className={`provider-settings-chevron ${expanded ? 'rotate-180' : ''}`} />
      </button>
      <div className="provider-settings-actions">
        {onToggleEnabled && <SettingsToggle checked={enabled ?? false} onChange={onToggleEnabled} disabled={disabled} ariaLabel={`Enable ${label} for ${scope}`} />}
        <Menu.Root><Menu.Trigger asChild><button className="provider-settings-more" aria-label={`More actions for ${scope}: ${label}`} disabled={disabled}><MoreHorizontal className="h-4 w-4" /></button></Menu.Trigger>
          <Menu.Portal><Menu.Content align="end" sideOffset={6}>
            <Menu.Item onSelect={onToggleExpand}>{expanded ? 'Close editor' : 'Edit configuration'}</Menu.Item>
            {actions.map(action => <Menu.Item key={action.label} onSelect={action.onSelect} className={action.destructive ? 'text-[var(--error)]' : ''}>{action.label}</Menu.Item>)}
          </Menu.Content></Menu.Portal>
        </Menu.Root>
      </div>
    </div>
    {expanded && <div id={id} className="provider-settings-editor">{children}</div>}
  </div>;
}
export function ProviderKeyEditor({ label, value, onChange, showKey, onToggleVisibility, busy, onSave, onCancel }: {
  label: string; value: string; onChange: (value: string) => void; showKey: boolean; onToggleVisibility: () => void;
  busy: boolean; onSave: () => void; onCancel: () => void;
}) {
  const inputId = useId();
  return <form onSubmit={event => { event.preventDefault(); if (!busy && value.trim()) onSave(); }}>
    <div className="provider-settings-field"><label htmlFor={inputId}>API key</label><span className="provider-key-input">
      <input id={inputId} aria-label={label} type={showKey ? 'text' : 'password'} value={value} onChange={event => onChange(event.target.value)} placeholder="Enter API key" autoFocus autoComplete="off" spellCheck={false} disabled={busy} />
      <button type="button" onClick={onToggleVisibility} disabled={busy} aria-label={`${showKey ? 'Hide' : 'Show'} ${label}`}>{showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}</button>
    </span></div>
    <div className="provider-editor-footer"><button type="button" className="provider-secondary-button" onClick={onCancel} disabled={busy}>Cancel</button><button type="submit" className="provider-primary-button" disabled={busy || !value.trim()}>{busy ? 'Saving…' : 'Save'}</button></div>
  </form>;
}

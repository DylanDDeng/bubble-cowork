import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { SettingsGroup, SettingsRow } from './SettingsPrimitives';
import { primeUserProfileCache } from '../../hooks/useUserProfile';
import { avatarColorFor, initialsOf } from '../../utils/user-avatar';
import type { UserProfile } from '../../../shared/types';

export function ProfileSettingsGroup() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [handle, setHandle] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(false);

  const applyProfile = (next: UserProfile) => {
    primeUserProfileCache(next);
    setProfile(next);
    setDisplayName(next.displayName);
    setHandle(next.handle);
  };

  useEffect(() => {
    let cancelled = false;
    setError('');
    window.electron.getUserProfile().then(next => {
      if (!cancelled) applyProfile(next);
    }).catch(() => { if (!cancelled) setError('Could not load profile.'); });
    return () => { cancelled = true; };
  }, [retry]);

  const save = async () => {
    if (!profile || saving) return;
    setSaving(true);
    try {
      applyProfile(await window.electron.saveUserProfile({ displayName: displayName.trim() || null, handle: handle.trim() || null }));
      toast.success('Profile saved.');
    } catch { toast.error('Could not save profile.'); }
    finally { setSaving(false); }
  };
  const dirty = Boolean(profile && (displayName !== profile.displayName || handle !== profile.handle));

  return <form className="space-y-6" onSubmit={event => { event.preventDefault(); void save(); }}>
    {error ? <div role="alert">{error} <button type="button" className="settings-button" onClick={() => setRetry(value => value + 1)}>Retry</button></div> : null}
    {profile && <div className="flex items-center gap-4">
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-lg font-medium text-white" style={{backgroundColor: avatarColorFor(profile.displayName)}} aria-hidden="true">{initialsOf(profile.displayName)}</div>
      <div><div className="font-medium">{profile.displayName}</div><div className="text-[var(--text-muted)]">{profile.handle ? `@${profile.handle}` : ''}</div></div>
    </div>}
    <SettingsGroup>
      <SettingsRow variant="card" label="Display name">
        <input className="settings-control w-[280px]" aria-label="Display name" value={displayName} onChange={event => setDisplayName(event.target.value)} placeholder="Your name" spellCheck={false} disabled={!profile || saving} />
      </SettingsRow>
      <SettingsRow variant="card" label="Handle">
        <input className="settings-control w-[280px]" aria-label="Handle" value={handle} onChange={event => setHandle(event.target.value)} placeholder="handle" spellCheck={false} disabled={!profile || saving} />
      </SettingsRow>
    </SettingsGroup>
    <div className="flex justify-end gap-2">
      <button type="button" className="settings-button" disabled={!dirty || saving} onClick={() => profile && applyProfile(profile)}>Cancel</button>
      <button type="submit" className="settings-primary-button" disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save'}</button>
    </div>
  </form>;
}

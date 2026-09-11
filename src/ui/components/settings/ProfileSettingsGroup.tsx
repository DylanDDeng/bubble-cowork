import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { SettingsGroup, SettingsRow } from './SettingsPrimitives';
import { primeUserProfileCache } from '../../hooks/useUserProfile';

export function ProfileSettingsGroup() {
  const [displayName, setDisplayName] = useState('');
  const [handle, setHandle] = useState('');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.electron
      .getUserProfile()
      .then((profile) => {
        primeUserProfileCache(profile);
        if (cancelled) return;
        setDisplayName(profile.displayName);
        setHandle(profile.handle);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    if (!loaded) return;
    try {
      const profile = await window.electron.saveUserProfile({
        displayName: displayName.trim() || null,
        handle: handle.trim() || null,
      });
      primeUserProfileCache(profile);
      setDisplayName(profile.displayName);
      setHandle(profile.handle);
    } catch {
      toast.error('Could not save profile.');
    }
  };

  const commitOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.currentTarget.blur();
    }
  };

  return (
    <SettingsGroup title="Profile">
      <SettingsRow
        variant="card"
        label="Display name"
        description="Shown on the usage page. Defaults to your git or system user name."
      >
        <input
          type="text"
          aria-label="Display name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          onBlur={() => void save()}
          onKeyDown={commitOnEnter}
          placeholder="Your name"
          spellCheck={false}
          disabled={!loaded}
          className="h-8 w-[280px] rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-right text-[12px] text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)] disabled:opacity-50"
        />
      </SettingsRow>

      <SettingsRow variant="card" label="Handle" description="Short lowercase ID, shown as @handle.">
        <input
          type="text"
          aria-label="Handle"
          value={handle}
          onChange={(event) => setHandle(event.target.value)}
          onBlur={() => void save()}
          onKeyDown={commitOnEnter}
          placeholder="handle"
          spellCheck={false}
          disabled={!loaded}
          className="h-8 w-[280px] rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-right font-mono text-[12px] text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)] disabled:opacity-50"
        />
      </SettingsRow>
    </SettingsGroup>
  );
}

import { useEffect, useState } from 'react';
import type { UserProfile } from '../../shared/types';

// Module-level cache so re-entering a view renders the profile immediately
// instead of flashing a placeholder while the IPC round-trip completes.
let cachedProfile: UserProfile | null = null;

export function primeUserProfileCache(profile: UserProfile): void {
  cachedProfile = profile;
}

export function useUserProfile(): UserProfile | null {
  const [profile, setProfile] = useState<UserProfile | null>(cachedProfile);

  useEffect(() => {
    let cancelled = false;
    window.electron
      .getUserProfile()
      .then((fresh) => {
        cachedProfile = fresh;
        if (!cancelled) {
          setProfile((current) => {
            if (
              current &&
              current.displayName === fresh.displayName &&
              current.handle === fresh.handle &&
              current.customized === fresh.customized
            ) {
              return current;
            }
            return fresh;
          });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return profile;
}

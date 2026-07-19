import { useEffect, useState } from 'react';
import type { KimiRuntimeStatus } from '../types';

const FALLBACK_STATUS: KimiRuntimeStatus = {
  ready: false,
  cliAvailable: false,
  cliPath: null,
  cliVersion: null,
  acpAvailable: false,
  serverAvailable: false,
  authState: 'unknown',
  loginCommand: 'kimi acp --login',
  summary: 'Kimi Code status unavailable.',
  detail: 'Aegis could not verify Kimi Code.',
  checkedAt: 0,
};

export function useKimiRuntimeStatus(enabled = true) {
  const [status, setStatus] = useState<KimiRuntimeStatus>(FALLBACK_STATUS);
  const [loading, setLoading] = useState(enabled);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    window.electron
      .getKimiRuntimeStatus()
      .then((nextStatus) => {
        if (!cancelled) {
          setStatus(nextStatus);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus({
            ...FALLBACK_STATUS,
            checkedAt: Date.now(),
          });
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, reloadKey]);

  return {
    status,
    loading,
    refresh: () => setReloadKey((current) => current + 1),
  };
}

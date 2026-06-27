import { useEffect, useState } from 'react';
import type { GrokRuntimeStatus } from '../types';

const FALLBACK_STATUS: GrokRuntimeStatus = {
  ready: false,
  cliAvailable: false,
  cliPath: null,
  cliVersion: null,
  acpAvailable: false,
  authState: 'unknown',
  loginCommand: 'grok login',
  summary: 'Grok Build status unavailable.',
  detail: 'Aegis could not verify Grok Build.',
  checkedAt: 0,
};

export function useGrokRuntimeStatus(enabled = true) {
  const [status, setStatus] = useState<GrokRuntimeStatus>(FALLBACK_STATUS);
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
      .getGrokRuntimeStatus()
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

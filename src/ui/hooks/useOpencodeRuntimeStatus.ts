import { useEffect, useState } from 'react';
import type { OpenCodeRuntimeStatus } from '../types';

const FALLBACK_STATUS: OpenCodeRuntimeStatus = {
  ready: false,
  cliAvailable: false,
  configExists: false,
  hasModelConfig: false,
  checkedAt: 0,
};

export function useOpencodeRuntimeStatus(enabled = true) {
  const [status, setStatus] = useState<OpenCodeRuntimeStatus>(FALLBACK_STATUS);
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
      .getOpencodeRuntimeStatus()
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

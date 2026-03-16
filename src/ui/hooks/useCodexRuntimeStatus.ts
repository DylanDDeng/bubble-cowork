import { useEffect, useState } from 'react';
import type { CodexRuntimeStatus } from '../types';

const FALLBACK_STATUS: CodexRuntimeStatus = {
  ready: false,
  cliAvailable: false,
  configExists: false,
  hasModelConfig: false,
  checkedAt: 0,
};

export function useCodexRuntimeStatus(enabled = true) {
  const [status, setStatus] = useState<CodexRuntimeStatus>(FALLBACK_STATUS);
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
      .getCodexRuntimeStatus()
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

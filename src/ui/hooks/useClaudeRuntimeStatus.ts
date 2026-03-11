import { useEffect, useState } from 'react';
import type { ClaudeRuntimeStatus } from '../types';

const FALLBACK_STATUS: ClaudeRuntimeStatus = {
  kind: 'error',
  ready: false,
  runtimeInstalled: false,
  runtimeSource: 'unknown',
  requiresAnthropicAuth: true,
  authSatisfied: false,
  hasApiKey: false,
  loggedIn: false,
  authMethod: null,
  apiProvider: null,
  cliPath: null,
  cliVersion: null,
  requestedModel: null,
  summary: 'Checking Claude runtime…',
  detail: 'Aegis is verifying the Claude runtime and authentication state.',
  installCommand: 'claude install stable',
  loginCommand: 'claude auth login',
  setupTokenCommand: 'claude setup-token',
  checkedAt: 0,
};

export function useClaudeRuntimeStatus(model?: string | null, enabled = true) {
  const [status, setStatus] = useState<ClaudeRuntimeStatus>(FALLBACK_STATUS);
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
      .getClaudeRuntimeStatus(model ?? null)
      .then((nextStatus) => {
        if (!cancelled) {
          setStatus(nextStatus);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : 'Unknown runtime check error.';
          const needsAppRestart =
            message.includes("No handler registered for 'get-claude-runtime-status'") ||
            message.includes('No handler registered');

          setStatus({
            ...FALLBACK_STATUS,
            summary: needsAppRestart
              ? 'App restart required.'
              : 'Claude runtime check failed.',
            detail: needsAppRestart
              ? 'The renderer has loaded the new Claude runtime check UI, but the Electron main process is still running the old code. Fully restart Aegis or restart the Electron dev process, then try again.'
              : message,
            installCommand: needsAppRestart ? null : FALLBACK_STATUS.installCommand,
            loginCommand: needsAppRestart ? null : FALLBACK_STATUS.loginCommand,
            setupTokenCommand: needsAppRestart ? null : FALLBACK_STATUS.setupTokenCommand,
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
  }, [enabled, model, reloadKey]);

  return {
    status,
    loading,
    refresh: () => setReloadKey((current) => current + 1),
  };
}

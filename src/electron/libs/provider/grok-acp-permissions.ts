import type { GrokPermissionMode } from '../../../shared/types';
import type { AcpJsonRpcClient } from './acp-json-rpc-client';

type PermissionRpc = Pick<AcpJsonRpcClient, 'request' | 'notify'>;

export function grokPermissionMeta(mode: GrokPermissionMode): Record<string, boolean> {
  return { yoloMode: mode === 'yolo', autoMode: mode === 'auto' };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Grok permission update timed out.')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Configure the native session, never synthesize approval responses in Aegis. */
export async function applyGrokPermissionMode(
  rpc: PermissionRpc,
  sessionId: string,
  mode: GrokPermissionMode,
  timeoutMs = 10_000
): Promise<void> {
  const yolo = mode === 'yolo';
  // Grok only exposes model and reasoning_effort through configOptions.
  // Its own client uses this extension for live permission changes. In
  // particular, session/resume ignores session/new's _meta permission flags.
  rpc.notify('_x.ai/yolo_mode_changed', {
    sessionId,
    yolo_mode: yolo,
    auto_mode: mode === 'auto',
  });

  const response = record(await bounded(rpc.request('_x.ai/sessions/list', {}), timeoutMs));
  // Grok's extension wraps the payload in `result` inside the JSON-RPC result.
  const payload = record(response?.result) ?? response;
  const sessions = payload?.sessions;
  const session = Array.isArray(sessions)
    ? sessions.map(record).find((item) => item?.sessionId === sessionId)
    : undefined;
  if (session?.yolo !== yolo) {
    throw new Error(`Grok did not confirm ${mode} permissions. The message was not sent. Retry or update Grok Build.`);
  }

  if (mode === 'plan') {
    // Do not silently run a requested read-only plan in ordinary execution
    // mode when the installed Grok version lacks a native plan-mode API.
    await bounded(rpc.request('session/set_config_option', {
      sessionId,
      configId: 'mode',
      value: mode,
    }), timeoutMs);
  }
}

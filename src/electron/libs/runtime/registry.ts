import type { AgentProvider } from '../../../shared/types';
import type { AgentRuntime, AgentRuntimeId } from './types';

const runtimes = new Map<AgentRuntimeId, AgentRuntime>();

type RuntimeMode = 'auto' | 'native' | 'provider';

export function registerRuntime(runtime: AgentRuntime): void {
  runtimes.set(runtime.id, runtime);
}

export function getRuntime(id: AgentRuntimeId): AgentRuntime | undefined {
  return runtimes.get(id);
}

export function getAllRuntimes(): AgentRuntime[] {
  return Array.from(runtimes.values());
}

function normalizeRuntimeMode(raw: string | undefined): RuntimeMode {
  const value = (raw || '').trim().toLowerCase();
  if (value === 'native') return 'native';
  if (value === 'provider') return 'provider';
  return 'auto';
}

function getConfiguredRuntimeMode(): RuntimeMode {
  return normalizeRuntimeMode(process.env.AEGIS_AGENT_RUNTIME);
}

function resolveProviderRuntimeId(provider: AgentProvider | undefined): AgentRuntimeId {
  if (provider === 'aegis') {
    return 'aegis';
  }
  // Codex is now handled by ProviderService, not RuntimeRegistry
  return provider === 'opencode'
    ? 'opencode'
    : 'claude';
}

export function resolveRuntime(provider: AgentProvider | undefined): AgentRuntime {
  const runtimeMode = getConfiguredRuntimeMode();
  const providerRuntimeId = resolveProviderRuntimeId(provider);
  // Codex is handled by ProviderService; only OpenCode uses native runtime
  const preferNative =
    runtimeMode === 'native' ||
    (runtimeMode === 'auto' && provider === 'opencode');

  if (preferNative) {
    const nativeRuntime = runtimes.get('native');
    if (nativeRuntime) {
      return nativeRuntime;
    }
  }

  const runtimeId = providerRuntimeId;
  const runtime = runtimes.get(runtimeId);
  if (runtime) {
    return runtime;
  }

  if (runtimeMode !== 'provider') {
    const nativeFallback = runtimes.get('native');
    if (nativeFallback) {
      return nativeFallback;
    }
  }

  const fallback = runtimes.get('claude');
  if (fallback) {
    return fallback;
  }

  throw new Error(`No runtime registered for provider "${runtimeId}".`);
}

/**
 * Pure verdict + cache layer for the Claude runtime check.
 *
 * No Electron/env imports: everything here computes over a ClaudeRuntimeProbe
 * snapshot, so it is unit-testable under plain Node. The probe itself (CLI
 * subprocess spawns) lives in claude-runtime-status.ts.
 */

import type { ClaudeRuntimeSource, ClaudeRuntimeStatus } from '../../shared/types';
import { isClaudeFamilyAlias, normalizeClaudeRequestedModel } from './claude-model-selection';

const INSTALL_COMMAND = 'npm install -g @anthropic-ai/claude-code';
const LOGIN_COMMAND = 'claude auth login';
const SETUP_TOKEN_COMMAND = 'claude setup-token';

/**
 * Model-independent facts gathered by the expensive runtime probe (two CLI
 * subprocesses). The per-model verdict is derived from this synchronously —
 * the model only decides `requiresAnthropicAuth`, a pure string check — so a
 * single cached probe serves every model without re-spawning anything.
 */
export interface ClaudeRuntimeProbe {
  runtimePath: string | null;
  runtimeSource: ClaudeRuntimeSource;
  cliVersion: string | null;
  loggedIn: boolean;
  /** Raw authMethod reported by `claude auth status` (final value is derived per model). */
  payloadAuthMethod: string | null;
  apiProvider: string | null;
  /** ANTHROPIC_API_KEY presence under the sanitized official env (auth-requiring models). */
  hasApiKeySanitized: boolean;
  /** ANTHROPIC_API_KEY presence under the raw env (compatible-provider models). */
  hasApiKeyUnsanitized: boolean;
  hasClaudeCodeAccount: boolean;
  /** `claude auth status` responded coherently (parsable payload or exit code 0/1). */
  authProbeResponsive: boolean;
  authProbeErrorMessage: string | null;
  checkedAt: number;
}

function requiresAnthropicAuthForModel(model?: string | null): boolean {
  const normalized = normalizeClaudeRequestedModel(model);
  if (!normalized) {
    return true;
  }
  // Bare family aliases (sonnet/opus/haiku) are official Anthropic models too.
  return normalized.startsWith('claude-') || isClaudeFamilyAlias(normalized);
}

function describeRuntimeLocation(source: ClaudeRuntimeSource): string {
  switch (source) {
    case 'global':
      return 'the user Claude Code runtime';
    default:
      return 'the Claude runtime';
  }
}

/**
 * Pure per-model verdict over a probe. Mirrors the pre-refactor
 * `getClaudeRuntimeStatus` output shape exactly.
 */
export function deriveClaudeRuntimeStatus(
  probe: ClaudeRuntimeProbe,
  model?: string | null
): ClaudeRuntimeStatus {
  const requestedModel = normalizeClaudeRequestedModel(model) || model?.trim() || null;
  const requiresAnthropicAuth = requiresAnthropicAuthForModel(requestedModel);
  const hasApiKey = requiresAnthropicAuth ? probe.hasApiKeySanitized : probe.hasApiKeyUnsanitized;

  if (!probe.runtimePath) {
    return {
      kind: 'install_required',
      ready: false,
      runtimeInstalled: false,
      runtimeSource: probe.runtimeSource,
      requiresAnthropicAuth,
      authSatisfied: false,
      hasApiKey,
      loggedIn: false,
      authMethod: null,
      apiProvider: null,
      cliPath: null,
      cliVersion: null,
      requestedModel,
      summary: 'Claude Code is not installed.',
      detail:
        'Aegis uses the Claude Code installed on this machine. Install Claude Code, make sure `claude` is available on PATH, then restart Aegis.',
      installCommand: INSTALL_COMMAND,
      loginCommand: LOGIN_COMMAND,
      setupTokenCommand: SETUP_TOKEN_COMMAND,
      checkedAt: probe.checkedAt,
    };
  }

  const runtimeLabel = describeRuntimeLocation(probe.runtimeSource);
  const authMethod =
    hasApiKey && !probe.loggedIn
      ? 'api_key'
      : probe.hasClaudeCodeAccount
        ? 'claude_code'
        : probe.payloadAuthMethod;
  const authSatisfied = !requiresAnthropicAuth || probe.loggedIn || hasApiKey;

  if (authSatisfied) {
    const detail = !requiresAnthropicAuth
      ? `Using ${requestedModel || 'a compatible provider model'} through ${runtimeLabel}. Anthropic login is not required for this model.`
      : authMethod === 'api_key'
        ? `Claude sessions can start with ${runtimeLabel} using an API key.`
        : `Claude sessions can start with ${runtimeLabel}${probe.cliVersion ? ` (v${probe.cliVersion})` : ''}.`;

    return {
      kind: 'ready',
      ready: true,
      runtimeInstalled: true,
      runtimeSource: probe.runtimeSource,
      requiresAnthropicAuth,
      authSatisfied: true,
      hasApiKey,
      loggedIn: probe.loggedIn,
      authMethod,
      apiProvider: probe.apiProvider,
      cliPath: probe.runtimePath,
      cliVersion: probe.cliVersion,
      requestedModel,
      summary: 'Claude Code is ready.',
      detail,
      installCommand: INSTALL_COMMAND,
      loginCommand: LOGIN_COMMAND,
      setupTokenCommand: SETUP_TOKEN_COMMAND,
      checkedAt: probe.checkedAt,
    };
  }

  if (probe.authProbeResponsive) {
    return {
      kind: 'login_required',
      ready: false,
      runtimeInstalled: true,
      runtimeSource: probe.runtimeSource,
      requiresAnthropicAuth,
      authSatisfied: false,
      hasApiKey,
      loggedIn: probe.loggedIn,
      authMethod,
      apiProvider: probe.apiProvider,
      cliPath: probe.runtimePath,
      cliVersion: probe.cliVersion,
      requestedModel,
      summary: 'Claude Code needs authentication.',
      detail:
        'Sign in with Claude Code or configure ANTHROPIC_API_KEY before using Anthropic Claude models in Aegis.',
      installCommand: INSTALL_COMMAND,
      loginCommand: LOGIN_COMMAND,
      setupTokenCommand: SETUP_TOKEN_COMMAND,
      checkedAt: probe.checkedAt,
    };
  }

  return {
    kind: 'error',
    ready: false,
    runtimeInstalled: true,
    runtimeSource: probe.runtimeSource,
    requiresAnthropicAuth,
    authSatisfied: false,
    hasApiKey,
    loggedIn: probe.loggedIn,
    authMethod,
    apiProvider: probe.apiProvider,
    cliPath: probe.runtimePath,
    cliVersion: probe.cliVersion,
    requestedModel,
    summary: 'Claude runtime check failed.',
    detail:
      probe.authProbeErrorMessage ||
      'Aegis could not verify Claude authentication status. Run "claude auth status" in a terminal and verify the runtime is healthy.',
    installCommand: INSTALL_COMMAND,
    loginCommand: LOGIN_COMMAND,
    setupTokenCommand: SETUP_TOKEN_COMMAND,
    checkedAt: probe.checkedAt,
  };
}

export function formatClaudeRuntimeBlockingMessage(status: ClaudeRuntimeStatus): string {
  if (status.kind === 'install_required') {
    return `${status.summary} ${status.detail} Suggested command: ${status.installCommand || INSTALL_COMMAND}`;
  }

  if (status.kind === 'login_required') {
    return `${status.summary} ${status.detail} Suggested command: ${status.loginCommand || LOGIN_COMMAND}`;
  }

  if (status.kind === 'error') {
    return `${status.summary} ${status.detail}`;
  }

  return status.summary;
}

// ────────────────────────────────────────
// Probe cache: one model-independent entry, stale-while-revalidate.
//
// The pre-send runtime gate used to await two CLI subprocesses (1-3s) on a
// cache slot keyed by exact model — the startup prefetch (model=null) never
// matched a real send, so users paid the probe on the first message and again
// every TTL. Now the probe is cached once and the per-model verdict is derived
// synchronously; a stale-but-ready cache answers immediately while a refresh
// runs in the background. The gate is advisory UX — a wrongly-stale "ready"
// just means the runner start surfaces its own error — so blocking a send is
// only justified when we have no evidence the runtime works for this model.
// ────────────────────────────────────────

/** Ready probes stay valid for 10 minutes before a background refresh. */
const READY_TTL_MS = 10 * 60 * 1000;
/**
 * Not-ready probes expire fast so "install CLI / log in, retry" recovers
 * without waiting out a long TTL.
 */
const NOT_READY_TTL_MS = 30 * 1000;

export interface ClaudeRuntimeStatusCache {
  get(model?: string | null): Promise<ClaudeRuntimeStatus>;
  invalidate(): void;
  prefetch(): Promise<void>;
}

export function createClaudeRuntimeStatusCache(options: {
  /** The expensive probe — injected so this module stays Electron-free. */
  probe: () => Promise<ClaudeRuntimeProbe>;
  now?: () => number;
  readyTtlMs?: number;
  notReadyTtlMs?: number;
}): ClaudeRuntimeStatusCache {
  const probe = options.probe;
  const now = options.now ?? Date.now;
  const readyTtlMs = options.readyTtlMs ?? READY_TTL_MS;
  const notReadyTtlMs = options.notReadyTtlMs ?? NOT_READY_TTL_MS;

  let cachedProbe: ClaudeRuntimeProbe | null = null;
  let inFlight: Promise<ClaudeRuntimeProbe> | null = null;

  // Concurrent callers share one probe (no double subprocess spawn).
  const refresh = (): Promise<ClaudeRuntimeProbe> => {
    if (!inFlight) {
      inFlight = probe()
        .then((result) => {
          cachedProbe = result;
          return result;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  };

  return {
    async get(model?: string | null): Promise<ClaudeRuntimeStatus> {
      if (cachedProbe) {
        // Block-vs-serve is decided on the DERIVED verdict for this model,
        // not raw probe health: a compatible-provider model is ready without
        // Anthropic auth, and must never block on a re-probe just because the
        // user isn't logged into Anthropic.
        const status = deriveClaudeRuntimeStatus(cachedProbe, model ?? null);
        const age = now() - cachedProbe.checkedAt;
        const ttl = status.ready ? readyTtlMs : notReadyTtlMs;
        if (age < ttl) {
          return status;
        }
        if (status.ready) {
          // Stale-while-revalidate: answer instantly, refresh off the send path.
          void refresh().catch(() => {});
          return status;
        }
      }

      return deriveClaudeRuntimeStatus(await refresh(), model ?? null);
    },
    invalidate(): void {
      cachedProbe = null;
    },
    async prefetch(): Promise<void> {
      try {
        await refresh();
      } catch {
        // Silent: the next get() retries.
      }
    },
  };
}


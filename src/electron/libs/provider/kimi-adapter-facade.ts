import { EventEmitter } from 'events';
import { KimiServerAdapter } from './kimi-server-adapter';
import { probeKimiDaemonCommand, type KimiServerTransport } from './kimi-server-manager';
import { resolveKimiBinary } from '../kimi-cli';
import type {
  ProviderAdapter,
  ProviderAdapterCapabilities,
  ProviderKind,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
} from './types';
import type {
  PermissionResult,
  ProviderComposerCapabilities,
  ProviderListSkillsInput,
  ProviderListSkillsResult,
} from '../../../shared/types';

/**
 * Facade adapter for `kimi`. Every thread runs on the local Kimi server; the
 * ACP runtime it used to route to is gone.
 *
 * The persisted session id still carries provenance: server ids are stored as
 * `server:<session_id>`, bare ids are pre-server history. A bare id is adopted
 * onto the server (which loads legacy-store sessions with their history) and
 * rewritten to the prefixed form once the adoption is accepted.
 */

export const KIMI_SERVER_ID_PREFIX = 'server:';

interface KimiCapabilityProbeOutcome {
  /** True when the probe actually answered (CLI ran to a clean verdict);
   * false for spawn failures/timeouts/missing binary, which prove nothing. */
  definitive: boolean;
  capable: boolean;
}

type KimiCapabilityProbeFn = () => Promise<KimiCapabilityProbeOutcome>;

let serverCapableProbe: Promise<KimiCapabilityProbeOutcome> | null = null;
/** Last DEFINITIVE probe verdict; null until one lands. Sync consumers
 * (session serializer, respawn predicate) read it via isKimiServerRuntimeConfirmed. */
let lastDefinitiveServerCapable: boolean | null = null;
let probeImpl: KimiCapabilityProbeFn = defaultCapabilityProbe;

/** Test seam (L1): replace/restore the CLI-backed probe. */
export function setKimiCapabilityProbeForTests(impl: KimiCapabilityProbeFn | null): void {
  probeImpl = impl || defaultCapabilityProbe;
  serverCapableProbe = null;
  lastDefinitiveServerCapable = null;
}

function defaultCapabilityProbe(): Promise<KimiCapabilityProbeOutcome> {
  return (async () => {
    const binary = await resolveKimiBinary();
    if (!binary) {
      // Missing binary proves nothing durable (mid-run installs happen);
      // re-probe on the next ask instead of pinning a stale verdict.
      return { definitive: false, capable: false };
    }
    const outcome = await probeKimiDaemonCommand(binary);
    return { definitive: outcome.definitive, capable: outcome.capable };
  })();
}

function runCapabilityProbe(): Promise<KimiCapabilityProbeOutcome> {
  if (serverCapableProbe) return serverCapableProbe;
  const probe = probeImpl().then(
    (outcome) => {
      if (outcome.definitive) {
        lastDefinitiveServerCapable = outcome.capable;
      } else if (serverCapableProbe === probe) {
        // Indeterminate outcomes are never cached: a transient execFile
        // timeout must not silently route every later new thread to ACP
        // (the runtime-flapping this facade's docblock forbids).
        serverCapableProbe = null;
      }
      return outcome;
    },
    (error) => {
      if (serverCapableProbe === probe) serverCapableProbe = null;
      throw error;
    }
  );
  serverCapableProbe = probe;
  return probe;
}

/**
 * Deterministic capability probe: does this CLI ship `kimi web` or the
 * legacy `kimi server run` command? (Not a version allowlist — unknown
 * versions pass if the capability exists.) Soft form: indeterminate reads as
 * `false` for THIS call but is not cached.
 */
export async function isKimiServerCapable(): Promise<boolean> {
  return (await runCapabilityProbe()).capable;
}

/**
 * Loud form for the session-start path: retries one indeterminate outcome,
 * then THROWS rather than reporting a CLI incapable on a probe that never
 * answered.
 */
export async function requireKimiServerCapability(): Promise<boolean> {
  let outcome = await runCapabilityProbe();
  if (!outcome.definitive) {
    outcome = await runCapabilityProbe();
  }
  if (!outcome.definitive) {
    throw new Error(
      'Could not determine whether the Kimi CLI supports the server runtime (probe failed twice). Retry in a moment.'
    );
  }
  return outcome.capable;
}

/**
 * Sync answer for id-less threads (session serializer, composer capability
 * gates): has the probe definitively confirmed the server runtime? An
 * unresolved probe reports false — the safe direction, since the affordances
 * behind this gate (steering a live turn) need a confirmed server.
 */
export function isKimiServerRuntimeConfirmed(): boolean {
  return lastDefinitiveServerCapable === true;
}

/** Resolves when the warm capability probe settles (F12 push-not-poll). */
export function warmKimiCapabilityProbe(): Promise<void> {
  return runCapabilityProbe().then(
    () => undefined,
    () => undefined
  );
}

export class KimiAdapterFacade implements ProviderAdapter {
  readonly provider: ProviderKind = 'kimi';
  readonly displayName = 'Kimi Code';
  readonly events = new EventEmitter();

  private readonly server: KimiServerAdapter;

  constructor(serverTransport: KimiServerTransport = {}) {
    this.server = new KimiServerAdapter(serverTransport);

    // Warm the capability probe so isKimiServerRuntimeConfirmed() has a
    // definitive verdict before (or shortly after) the first list renders.
    void warmKimiCapabilityProbe();

    // Server events get the provenance prefix stamped onto every surface that
    // carries a provider session id, so persistence round-trips it.
    this.server.events.on('event', (event: ProviderRuntimeEvent) => {
      if (event.type === 'system_init') {
        this.events.emit('event', { ...event, sessionId: KIMI_SERVER_ID_PREFIX + event.sessionId });
        return;
      }
      if (event.type === 'stop_settled') {
        this.events.emit('event', {
          ...event,
          providerThreadId: event.providerThreadId
            ? KIMI_SERVER_ID_PREFIX + event.providerThreadId
            : '',
        });
        return;
      }
      this.events.emit('event', event);
    });
  }

  get capabilities(): ProviderAdapterCapabilities {
    return this.server.capabilities;
  }

  getComposerCapabilities(): ProviderComposerCapabilities {
    return this.server.getComposerCapabilities();
  }

  private runtimeFor(threadId: string): ProviderAdapter | null {
    return this.server.hasSession(threadId) ? this.server : null;
  }

  /** Throws when the CLI cannot run the server runtime — there is no fallback. */
  private async requireServerRuntime(): Promise<void> {
    if (!(await requireKimiServerCapability())) {
      throw new Error(
        'The detected kimi executable does not expose the server runtime. Update Kimi Code, then restart Aegis.'
      );
    }
  }

  async startSession(input: ProviderSessionStartInput): Promise<ProviderSession> {
    const resumeId = input.resumeSessionId?.trim() || '';

    // Provenance stickiness: the stored id decides the runtime, never a flag.
    if (resumeId.startsWith(KIMI_SERVER_ID_PREFIX)) {
      const session = await this.server.startSession({
        ...input,
        resumeSessionId: resumeId.slice(KIMI_SERVER_ID_PREFIX.length),
      });
      return { ...session, providerSessionId: KIMI_SERVER_ID_PREFIX + session.providerSessionId };
    }
    if (resumeId) {
      // Legacy (bare-id) thread: ADOPT it on the server runtime, which loads
      // legacy-store sessions with their history. The bare id is only
      // rewritten (via the prefixed system_init) once the adoption subscribe
      // is ACCEPTED. A daemon boot failure on a capable CLI throws loudly
      // rather than quietly abandoning a still-valid id.
      await this.requireServerRuntime();
      // resolveResume verifies + retries; it throws (id untouched) when the
      // session exists but cannot be attached right now.
      const adoption = await this.server.manager.resolveResume(resumeId);
      if (adoption === 'accepted') {
        let session: ProviderSession;
        try {
          session = await this.server.startSession({ ...input, resumeSessionId: resumeId });
        } catch (error) {
          // Don't leak the pre-check subscription: an orphan registry
          // entry gets resubscribed on every reconnect forever.
          this.server.manager.unsubscribeSession(resumeId);
          throw error;
        }
        console.info(
          `[KimiAdapterFacade] adopted legacy kimi thread ${input.threadId} onto the server runtime (${resumeId})`
        );
        return { ...session, providerSessionId: KIMI_SERVER_ID_PREFIX + session.providerSessionId };
      }
      // The server does not know this id. There is no second runtime to fall
      // back to, so continue the thread on a fresh server session: the
      // transcript stays, only the agent-side context is gone.
      console.info(
        `[KimiAdapterFacade] legacy kimi id ${resumeId} is unknown to the server — starting a fresh session for thread ${input.threadId}`
      );
      const fresh = await this.server.startSession({ ...input, resumeSessionId: undefined });
      return { ...fresh, providerSessionId: KIMI_SERVER_ID_PREFIX + fresh.providerSessionId };
    }

    await this.requireServerRuntime();
    const session = await this.server.startSession(input);
    return { ...session, providerSessionId: KIMI_SERVER_ID_PREFIX + session.providerSessionId };
  }

  async sendTurn(input: ProviderSendTurnInput): Promise<void> {
    const runtime = this.runtimeFor(input.threadId);
    if (!runtime) {
      throw new Error(`No Kimi session found for thread "${input.threadId}"`);
    }
    await runtime.sendTurn(input);
  }

  disposeSession(_threadId: string): boolean {
    // Policy no-op: kimi has its own zombie handling (kimiSessionReleased
    // respawn guard keyed on hasSession) and the binding must survive an
    // errored turn — do NOT delegate to the inner adapter here.
    return false;
  }

  async stopSession(threadId: string): Promise<void> {
    // Unknown threads go through too: the server settles the stop gate, which
    // must never hang on kimi.
    await this.server.stopSession(threadId);
  }

  async stopAll(): Promise<void> {
    await this.server.stopAll();
  }

  /** Synchronous best-effort daemon kill for before-quit. */
  killServerDaemonSync(): void {
    this.server.manager.killSync();
  }

  listSessions(): ProviderSession[] {
    return this.server.listSessions().map((session) => ({
      ...session,
      providerSessionId: KIMI_SERVER_ID_PREFIX + session.providerSessionId,
    }));
  }

  hasSession(threadId: string): boolean {
    return this.server.hasSession(threadId);
  }

  async respondToRequest(threadId: string, requestId: string, decision: PermissionResult): Promise<void> {
    const runtime = this.runtimeFor(threadId);
    if (!runtime) return;
    await runtime.respondToRequest(threadId, requestId, decision);
  }

  private serverModelCache: { items: Array<Record<string, unknown>>; fetchedAt: number } | null = null;

  /** Synchronous read of the cached server model metadata (no daemon I/O). */
  peekServerModels(): Array<Record<string, unknown>> | null {
    return this.serverModelCache?.items ?? null;
  }

  /**
   * Raw server `GET /models` items (with `support_efforts`/`default_effort`
   * thinking metadata the CLI listing lacks) — null when the server runtime
   * is unavailable. Cached briefly; model metadata changes only with CLI
   * upgrades.
   */
  async getServerModels(): Promise<Array<Record<string, unknown>> | null> {
    if (!(await isKimiServerCapable())) {
      return null;
    }
    if (this.serverModelCache && Date.now() - this.serverModelCache.fetchedAt < 60_000) {
      return this.serverModelCache.items;
    }
    try {
      await this.server.manager.ensureDaemon();
      const items = await this.server.manager.listModels();
      this.serverModelCache = { items, fetchedAt: Date.now() };
      return items;
    } catch (error) {
      console.warn('[KimiAdapterFacade] server model listing failed:', error);
      return null;
    }
  }

  async listSkills(input: ProviderListSkillsInput): Promise<ProviderListSkillsResult> {
    if (await isKimiServerCapable()) {
      return this.server.listSkills(input);
    }
    return { skills: [], source: 'unsupported', cached: false };
  }

  async forkThread(input: { cwd: string; providerThreadId: string }): Promise<string> {
    if (!input.providerThreadId.startsWith(KIMI_SERVER_ID_PREFIX)) {
      throw new Error('Forking is only supported for Kimi server-runtime threads.');
    }
    const forked = await this.server.forkThread!({
      cwd: input.cwd,
      providerThreadId: input.providerThreadId.slice(KIMI_SERVER_ID_PREFIX.length),
    });
    return KIMI_SERVER_ID_PREFIX + forked;
  }

  async runOneShot(
    input: ProviderSessionStartInput
  ): Promise<{ text: string; sessionId?: string; model?: string }> {
    await this.requireServerRuntime();
    const result = await this.server.runOneShot(input);
    return {
      ...result,
      sessionId: result.sessionId ? KIMI_SERVER_ID_PREFIX + result.sessionId : undefined,
    };
  }
}

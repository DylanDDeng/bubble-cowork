import { execFile } from 'child_process';
import { EventEmitter } from 'events';
import { KimiAcpAdapter } from './kimi-acp-adapter';
import { KimiServerAdapter } from './kimi-server-adapter';
import type { KimiServerTransport } from './kimi-server-manager';
import { buildKimiEnv, resolveKimiBinary } from '../kimi-cli';
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
 * Facade adapter for `kimi`: routes each thread to the ACP or server runtime
 * by PROVENANCE, not by a global flag (docs/kimi-server-adapter-plan.md,
 * Rollout). Provenance rides in the persisted session id: server-runtime ids
 * are stored as `server:<session_id>`; bare ids are ACP threads (all
 * pre-facade history). A thread only ever resumes on the runtime that
 * created it — the ACP↔server session spaces are disjoint (M0 probe D).
 *
 * The default runtime for NEW threads is capability-based and deterministic:
 * `kimi server` subcommand present ⇒ server; `AEGIS_KIMI_RUNTIME=acp|server`
 * overrides (dev-only escape hatch). A transient boot failure of a capable
 * CLI surfaces an error — it must NOT flip the thread to ACP (flapping
 * corrupts resume ids).
 */

export type KimiRuntimeKind = 'acp' | 'server';

export const KIMI_SERVER_ID_PREFIX = 'server:';

export function resolveKimiRuntimeOverride(): KimiRuntimeKind | null {
  const env = (process.env.AEGIS_KIMI_RUNTIME || '').trim().toLowerCase();
  return env === 'acp' || env === 'server' ? env : null;
}

interface KimiCapabilityProbeOutcome {
  /** True when the probe actually answered (CLI ran to a clean verdict);
   * false for spawn failures/timeouts/missing binary, which prove nothing. */
  definitive: boolean;
  capable: boolean;
}

type KimiCapabilityProbeFn = () => Promise<KimiCapabilityProbeOutcome>;

let serverCapableProbe: Promise<KimiCapabilityProbeOutcome> | null = null;
/** Last DEFINITIVE probe verdict; null until one lands. Sync consumers
 * (session serializer, respawn predicate) read it via getKimiDefaultRuntime. */
let lastDefinitiveServerCapable: boolean | null = null;
let probeImpl: KimiCapabilityProbeFn = defaultCapabilityProbe;

/** Test seam (L1): replace/restore the execFile-backed probe. */
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
    return new Promise<KimiCapabilityProbeOutcome>((resolve) => {
      execFile(
        binary,
        ['server', '--help'],
        { timeout: 5_000, env: buildKimiEnv() },
        (error, stdout, stderr) => {
          const output = `${stdout || ''}${stderr || ''}`;
          if (!error) {
            resolve({ definitive: true, capable: /\brun\b/.test(output) });
            return;
          }
          const err = error as NodeJS.ErrnoException & { killed?: boolean };
          // A clean non-zero exit (numeric code) means the CLI ran and
          // rejected the subcommand — a definitive NO for old CLIs. Timeouts
          // (killed) and spawn errors (string code / no code) prove nothing.
          const definitive = typeof err.code === 'number' && err.killed !== true;
          resolve({ definitive, capable: false });
        }
      );
    });
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
 * Deterministic capability probe: does this CLI ship the `server` subcommand?
 * (Not a version allowlist — unknown versions pass if the capability exists.)
 * Soft form: indeterminate reads as `false` for THIS call but is not cached.
 */
export async function isKimiServerCapable(): Promise<boolean> {
  return (await runCapabilityProbe()).capable;
}

/**
 * Loud form for the session-start path: retries one indeterminate outcome,
 * then THROWS instead of silently creating an ACP thread — only a definitive
 * "no server subcommand" may route new threads to the legacy runtime.
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
 * Sync default runtime for id-less threads (session serializer, composer
 * capability gates). Unresolved probe reports 'acp' — the safe direction:
 * worst case the steer UI stays disabled until the warm probe settles,
 * versus steering into an ACP adapter that cannot take concurrent prompts.
 */
export function getKimiDefaultRuntime(): KimiRuntimeKind {
  const override = resolveKimiRuntimeOverride();
  if (override) return override;
  return lastDefinitiveServerCapable ? 'server' : 'acp';
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

  private readonly acp: KimiAcpAdapter;
  private readonly server: KimiServerAdapter;

  constructor(serverTransport: KimiServerTransport = {}) {
    this.acp = new KimiAcpAdapter();
    this.server = new KimiServerAdapter(serverTransport);

    // Warm the capability probe so getKimiDefaultRuntime() has a definitive
    // verdict before (or shortly after) the first session list renders.
    void warmKimiCapabilityProbe();

    // ACP events pass through untouched (bare ids = ACP provenance).
    this.acp.events.on('event', (event: ProviderRuntimeEvent) => {
      this.events.emit('event', event);
    });
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

  /**
   * Advertised for the DEFAULT runtime of new threads. Old ACP threads keep
   * working; server-only affordances (fork/compact/model switch) fail loudly
   * on them rather than silently downgrading new threads.
   */
  get capabilities(): ProviderAdapterCapabilities {
    return getKimiDefaultRuntime() === 'acp' ? this.acp.capabilities : this.server.capabilities;
  }

  getComposerCapabilities(): ProviderComposerCapabilities {
    return getKimiDefaultRuntime() === 'acp'
      ? this.acp.getComposerCapabilities()
      : this.server.getComposerCapabilities();
  }

  private runtimeFor(threadId: string): ProviderAdapter | null {
    if (this.server.hasSession(threadId)) return this.server;
    if (this.acp.hasSession(threadId)) return this.acp;
    return null;
  }

  private async pickRuntimeForNewThread(): Promise<KimiRuntimeKind> {
    const override = resolveKimiRuntimeOverride();
    if (override) return override;
    // Loud form: a transient probe failure throws instead of silently
    // creating an ACP thread (bare persisted id = provenance corruption).
    return (await requireKimiServerCapability()) ? 'server' : 'acp';
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
      // Legacy (bare-id) thread. Default path: ADOPT it on the server
      // runtime — the server loads legacy-store sessions with full history
      // (probed on 0.27.0, incl. a 2026-07-03 session). The bare id is only
      // rewritten (via the prefixed system_init) after the adoption
      // subscribe is ACCEPTED; when the server does not know the id
      // (not_found), the thread stays on the legacy runtime with its id
      // untouched — a still-valid legacy id is never destroyed. A daemon
      // boot failure on a capable CLI throws loudly instead of flapping to
      // the legacy runtime (provenance corruption guard).
      if ((await this.pickRuntimeForNewThread()) === 'server') {
        // resolveResume verifies + retries; it throws (id untouched) when
        // the session exists but cannot be attached right now.
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
      }
      return this.acp.startSession(input);
    }

    const runtime = await this.pickRuntimeForNewThread();
    if (runtime === 'server') {
      const session = await this.server.startSession(input);
      return { ...session, providerSessionId: KIMI_SERVER_ID_PREFIX + session.providerSessionId };
    }
    return this.acp.startSession(input);
  }

  async sendTurn(input: ProviderSendTurnInput): Promise<void> {
    const runtime = this.runtimeFor(input.threadId);
    if (!runtime) {
      throw new Error(`No Kimi session found for thread "${input.threadId}"`);
    }
    await runtime.sendTurn(input);
  }

  async stopSession(threadId: string): Promise<void> {
    if (this.server.hasSession(threadId)) {
      await this.server.stopSession(threadId);
      return;
    }
    if (this.acp.hasSession(threadId)) {
      // The ACP runtime has no interrupt confirmation — stopping kills the
      // child process, which IS the definitive stop. Emit the settle here so
      // the ipc two-phase stop gate works for both kimi runtimes.
      const providerThreadId =
        this.acp.listSessions().find((session) => session.threadId === threadId)
          ?.providerSessionId || '';
      await this.acp.stopSession(threadId);
      this.events.emit('event', {
        type: 'stop_settled',
        threadId,
        providerThreadId,
        generation: 0,
        confirmed: true,
      } satisfies ProviderRuntimeEvent);
      return;
    }
    // Unknown thread: still settle so a stop gate can never hang on kimi.
    await this.server.stopSession(threadId);
  }

  async stopAll(): Promise<void> {
    await Promise.all([this.acp.stopAll(), this.server.stopAll()]);
  }

  /** Synchronous best-effort daemon kill for before-quit. */
  killServerDaemonSync(): void {
    this.server.manager.killSync();
  }

  listSessions(): ProviderSession[] {
    return [
      ...this.acp.listSessions(),
      ...this.server.listSessions().map((session) => ({
        ...session,
        providerSessionId: KIMI_SERVER_ID_PREFIX + session.providerSessionId,
      })),
    ];
  }

  hasSession(threadId: string): boolean {
    return this.acp.hasSession(threadId) || this.server.hasSession(threadId);
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
    if (resolveKimiRuntimeOverride() === 'acp' || !(await isKimiServerCapable())) {
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

  /** Skill discovery is server-runtime only (the ACP surface has none). */
  async listSkills(input: ProviderListSkillsInput): Promise<ProviderListSkillsResult> {
    if (resolveKimiRuntimeOverride() !== 'acp' && (await isKimiServerCapable())) {
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
    if ((await this.pickRuntimeForNewThread()) === 'server') {
      const result = await this.server.runOneShot(input);
      return {
        ...result,
        sessionId: result.sessionId ? KIMI_SERVER_ID_PREFIX + result.sessionId : undefined,
      };
    }
    return this.runAcpOneShot(input);
  }

  /** Generic collect-until-result loop over the ACP runtime (no native one-shot). */
  private async runAcpOneShot(
    input: ProviderSessionStartInput
  ): Promise<{ text: string; sessionId?: string; model?: string }> {
    let text = '';
    let sessionId: string | undefined;
    let model: string | undefined;

    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Kimi ACP one-shot prompt timed out.'));
      }, 300_000);
      timer.unref?.();
      const listener = (event: ProviderRuntimeEvent) => {
        if (event.threadId !== input.threadId) return;
        if (event.type === 'system_init') {
          sessionId = event.sessionId;
          model = event.model || model;
          return;
        }
        if (event.type === 'message' && event.message.type === 'assistant' && !event.message.streaming) {
          for (const block of event.message.message.content) {
            if (block.type === 'text' && block.text) {
              text += block.text;
            }
          }
          return;
        }
        if (event.type === 'message' && event.message.type === 'result') {
          cleanup();
          if (event.message.subtype === 'success') resolve();
          else reject(new Error('Kimi ACP one-shot turn failed.'));
          return;
        }
        if (event.type === 'error') {
          cleanup();
          reject(event.error);
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.acp.events.off('event', listener);
      };
      this.acp.events.on('event', listener);
    });

    try {
      await this.acp.startSession(input);
      await done;
      return { text: text.trim(), sessionId, model };
    } finally {
      await this.acp.stopSession(input.threadId).catch(() => {});
    }
  }
}

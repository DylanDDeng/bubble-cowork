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

let serverCapableProbe: Promise<boolean> | null = null;

/**
 * Deterministic capability probe: does this CLI ship the `server` subcommand?
 * (Not a version allowlist — unknown versions pass if the capability exists.)
 */
export function isKimiServerCapable(forceReload = false): Promise<boolean> {
  if (!forceReload && serverCapableProbe) return serverCapableProbe;
  serverCapableProbe = (async () => {
    const binary = await resolveKimiBinary();
    if (!binary) return false;
    return new Promise<boolean>((resolve) => {
      execFile(
        binary,
        ['server', '--help'],
        { timeout: 5_000, env: buildKimiEnv() },
        (error, stdout, stderr) => {
          const output = `${stdout || ''}${stderr || ''}`;
          resolve(!error && /\brun\b/.test(output));
        }
      );
    });
  })();
  return serverCapableProbe;
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
    return resolveKimiRuntimeOverride() === 'acp' ? this.acp.capabilities : this.server.capabilities;
  }

  getComposerCapabilities(): ProviderComposerCapabilities {
    return resolveKimiRuntimeOverride() === 'acp'
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
    return (await isKimiServerCapable()) ? 'server' : 'acp';
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

import { randomBytes, randomUUID, createHash, timingSafeEqual } from "crypto";
import { listProjectDir, readProjectFile, searchProjectFiles } from "./project-files";
import { hostname } from "os";
import { join } from "path";
import WebSocket from "ws";
import { RemoteJournal } from "./journal";
import { defaultRelay, hostProof, identityKeys, pushRequest, relayHttpOrigin, roomFor } from "./relay-auth";
import {
  REMOTE_PROTOCOL,
  requestSchema,
  type RemoteMessage,
  type RemotePermission,
  type RemoteSession,
  type RemoteProject,
  type CommandResult,
  type Pairing,
  type RemoteEnvironment,
  type RemoteAgentOptions,
  type RemoteAttachment,
  type RemoteTaskSettings,
  type RemoteCapabilities,
  type RemoteProvider,
  providerSchema,
} from "../../shared/remote/protocol";
import type { ServerEvent, PermissionRequestPayload, Attachment } from "../../shared/types";

/** Settings a phone may attach to a new task or a follow-up. */
export interface RemoteTaskExtras {
  settings?: RemoteTaskSettings;
  worktree?: boolean;
  attachments?: Attachment[];
}
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const UPLOAD_TTL = 10 * 60 * 1000;

interface Project extends RemoteProject {
  path: string;
}
const permissionDetail = (p: PermissionRequestPayload) => JSON.stringify(p.input, null, 2) ?? "";
const canApproveRemotely = (p: PermissionRequestPayload) =>
  !/question|plan|computer/i.test(p.toolName) && permissionDetail(p).length <= 24000;
export interface RemoteRuntime {
  environment?: RemoteEnvironment;
  projects(): Project[];
  sessions(): RemoteSession[];
  history(id: string): RemoteMessage[];
  start(
    project: Project,
    provider: "claude" | "codex" | "bubble" | "devin" | "mimo",
    prompt: string,
    extras?: RemoteTaskExtras,
  ): Promise<string | null>;
  send(id: string, prompt: string, extras?: RemoteTaskExtras): Promise<boolean>;
  /** Agent catalog for the phone's pickers; must not include secrets. */
  options?(): Promise<RemoteAgentOptions>;
  /** Slash commands and skills for a provider in a project (and session, if any). */
  capabilities?(provider: RemoteProvider, cwd: string, sessionId?: string): Promise<RemoteCapabilities>;
  /** Stores uploaded bytes as a desktop attachment (type and size validated). */
  attach?(name: string, data: Uint8Array): Promise<Attachment>;
  stop(id: string): void;
  permission(
    request: PermissionRequestPayload,
    decision: "allow" | "deny",
  ): boolean;
  hasPermission(id: string, toolUseId: string): boolean;
  confirm(name: string, peerId: string): Promise<boolean>;
}
export class RemoteGateway {
  readonly hostBootId = randomUUID();
  private socket?: WebSocket;
  private channel?: Awaited<
    ReturnType<
      typeof import("../../shared/remote/secure-channel").secureChannel
    >
  >;
  private retry?: ReturnType<typeof setTimeout>;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private invite?: { value: string; expiresAt: number; claimed: boolean };
  private runIds = new Map<string, string>();
  private permissions = new Map<string, PermissionRequestPayload>();
  private live = new Map<string, Map<string, RemoteMessage>>();
  private activePeer?: string;
  /** The connected phone's app is off screen (switched away or locked). */
  private peerAway = false;
  private pendingCommands = new Set<string>();
  private uploads = new Map<string, { peer: string; name: string; total: number; parts: Buffer[]; bytes: number; at: number }>();
  private uploaded = new Map<string, { peer: string; attachment: Attachment; at: number }>();
  private attempt = 0;
  private relayError?: string;
  private running = new Set<string>();
  private notified = new Map<string, number>();
  status = "disabled";
  constructor(
    readonly journal: RemoteJournal,
    private runtime: RemoteRuntime,
  ) {}
  private crypto(): typeof import("../../shared/remote/secure-channel") {
    return require(join(__dirname, "secure-channel.cjs"));
  }
  describe() {
    return {
      status: this.status,
      enabled: this.journal.state.config?.enabled ?? false,
      environment: this.runtime.environment ?? "development",
      relay: this.journal.state.config?.relay ?? "",
      defaultRelay: defaultRelay(),
      relayError: this.relayError,
      projects: this.runtime.projects().map(({ id, name }) => ({ id, name })),
      devices: this.journal.state.devices,
    };
  }
  /** An empty relay means the public Aegis relay; the token is only for self-hosted relays. */
  async configure(relay: string | undefined, registrationToken: string | undefined) {
    const url = new URL(relay?.trim() || defaultRelay());
    if (
      url.protocol !== "wss:" &&
      !(
        url.protocol === "ws:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      )
    )
      throw new Error("Use WSS for remote connections");
    if (url.username || url.password || url.search || url.hash)
      throw new Error("Relay URL must not contain credentials");
    registrationToken = registrationToken?.trim() || undefined;
    if (registrationToken && (registrationToken.length < 32 || registrationToken.length > 128))
      throw new Error("Invalid relay registration token");
    this.close();
    const identity = await this.crypto().createIdentity();
    this.journal.update((s) => {
      s.config = {
        relay: url.toString(),
        ...(registrationToken ? { registrationToken } : {}),
        room: roomFor(identityKeys(identity.privateKey).publicKey),
        routeToken: randomBytes(32).toString("hex"),
        identity: identity.privateKey,
        peerId: identity.peerId,
        enabled: true,
      };
      s.devices = [];
    });
    this.connect();
    return this.describe();
  }
  pairing(): Pairing {
    const config = this.journal.state.config;
    if (!config?.enabled || !["waiting", "connected"].includes(this.status))
      throw new Error("Wait for the relay connection");
    this.invite = {
      value: randomBytes(32).toString("hex"),
      expiresAt: Date.now() + 120000,
      claimed: false,
    };
    return {
      version: 1,
      environment: this.runtime.environment ?? "development",
      relay: config.relay,
      room: config.room,
      routeToken: config.routeToken,
      hostPeerId: config.peerId,
      name: hostname(),
      invite: this.invite.value,
      expiresAt: this.invite.expiresAt,
    };
  }
  revoke(peerId: string) {
    this.journal.update((s) => {
      s.devices = s.devices.filter((d) => d.peerId !== peerId);
    });
    this.invite = undefined;
    if (this.activePeer === peerId) {
      try {
        this.channel?.send({ type: "revoked" });
      } catch {}
      const socket = this.socket;
      setTimeout(() => socket?.close(), 100);
    }
    return this.describe();
  }
  disable() {
    this.journal.update((s) => {
      if (s.config) s.config.enabled = false;
    });
    this.close();
    return this.describe();
  }
  close() {
    this.generation++;
    clearTimeout(this.retry);
    clearTimeout(this.timer);
    this.invite = undefined;
    this.channel?.close();
    this.socket?.close();
    this.channel = undefined;
    this.activePeer = undefined;
    this.status = "disabled";
  }
  connect() {
    let config = this.journal.state.config;
    if (!config?.enabled) return;
    const keys = identityKeys(config.identity);
    const room = roomFor(keys.publicKey);
    if (config.room !== room) {
      // Rooms used to be random; they now follow the host key. Phones re-pair once.
      this.journal.update((s) => {
        s.config!.room = room;
      });
      config = this.journal.state.config!;
    }
    const generation = ++this.generation;
    clearTimeout(this.retry);
    this.status = "connecting";
    const socket = new WebSocket(config.relay, {
      maxPayload: 256 * 1024,
      perMessageDeflate: false,
    });
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    // A lossy or stalled path can leave the socket open but silent. The relay
    // answers pings, so a quiet 10 s means reconnect instead of waiting on TCP.
    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }, 10000);
    socket.on("pong", () => {
      alive = true;
    });
    socket.on("message", () => {
      alive = true;
    });
    socket.on("close", () => clearInterval(heartbeat));
    socket.on("open", () =>
      socket.send(
        JSON.stringify({
          role: "host",
          room,
          token: config.routeToken,
          publicKey: keys.publicKey,
          ...(config.registrationToken ? { registrationToken: config.registrationToken } : {}),
        }),
      ),
    );
    const control = (event: any) => {
      if (typeof event.data !== "string") {
        socket.close();
        return;
      }
      let message: { type?: string; nonce?: string };
      try {
        message = JSON.parse(event.data);
      } catch {
        socket.close();
        return;
      }
      const type = message.type;
      if (type === "challenge" && typeof message.nonce === "string" && /^[a-f0-9]{64}$/.test(message.nonce))
        socket.send(JSON.stringify({ type: "proof", signature: keys.sign(hostProof(message.nonce, room)).toString("base64") }));
      else if (type === "registered") {
        this.status = "waiting";
        this.attempt = 0;
        this.relayError = undefined;
      } else if (type === "peer") {
        socket.removeEventListener("message", control);
        void this.accept(socket, generation).catch(() => socket.close());
      } else socket.close();
    };
    socket.addEventListener("message", control);
    socket.on("error", () => {
      this.status = "offline";
    });
    socket.on("close", (code: number, reason: Buffer) => {
      if (generation !== this.generation) return;
      this.channel = undefined;
      this.activePeer = undefined;
      // 1008 is the relay refusing this Mac; retrying fast would not change that.
      const rejected = code === 1008;
      this.status = rejected ? "rejected" : "offline";
      if (rejected) this.relayError = reason.toString().slice(0, 120) || "Connection rejected";
      const base = rejected ? 60000 : Math.min(60000, 1500 * 2 ** this.attempt++);
      this.retry = setTimeout(() => this.connect(), base * (0.8 + Math.random() * 0.4));
    });
  }
  private async accept(socket: WebSocket, generation: number) {
    const config = this.journal.state.config!;
    const channel = await this.crypto().secureChannel(
      socket as any,
      config.identity,
      false,
    );
    const authTimeout = setTimeout(() => channel.close(), 15000);
    try {
      const first = await channel.messages.next();
      const auth = first.value as any;
      if (
        auth?.type !== "auth" ||
        auth.protocol !== REMOTE_PROTOCOL ||
        auth.environment !== (this.runtime.environment ?? "development") ||
        typeof auth.name !== "string" ||
        auth.name.length > 80
      )
        throw new Error("Invalid auth");
      let device = this.journal.state.devices.find(
        (d) => d.peerId === channel.peerId,
      );
      if (!device) {
        const invite = this.invite;
        if (
          !invite ||
          invite.claimed ||
          invite.expiresAt < Date.now() ||
          typeof auth.invite !== "string" ||
          auth.invite.length !== invite.value.length ||
          !timingSafeEqual(Buffer.from(auth.invite), Buffer.from(invite.value))
        )
          throw new Error("Pairing expired");
        invite.claimed = true;
        clearTimeout(authTimeout);
        const approved = await this.runtime.confirm(auth.name, channel.peerId);
        if (
          !approved ||
          generation !== this.generation ||
          this.invite !== invite ||
          invite.expiresAt < Date.now()
        )
          throw new Error("Pairing rejected");
        device = {
          peerId: channel.peerId,
          name: auth.name,
          pairedAt: Date.now(),
        };
        this.journal.update((s) => s.devices.push(device!));
        this.invite = undefined;
      }
      clearTimeout(authTimeout);
      if (generation !== this.generation) throw new Error("Stale connection");
      this.channel = channel;
      this.activePeer = device.peerId;
      this.peerAway = false;
      this.status = "connected";
      channel.send({
        type: "authenticated",
        environment: this.runtime.environment ?? "development",
        protocol: REMOTE_PROTOCOL,
        hostBootId: this.hostBootId,
        serverTime: Date.now(),
      });
      for await (const data of channel.messages) {
        if (
          generation !== this.generation ||
          !this.journal.state.devices.some((d) => d.peerId === channel.peerId)
        )
          throw new Error("Revoked");
        // Controls remain responsive while a provider starts or handles a prompt.
        // Too many at once is answered per request; it must not read as a revoked pairing.
        if (this.pendingCommands.size >= 32) {
          const id = typeof (data as any)?.id === "string" ? (data as any).id.slice(0, 160) : "";
          channel.send({ type: "response", id, error: "TOO_MANY_REQUESTS" });
          continue;
        }
        void this.dispatch(data, channel.peerId)
          .then((result) => {
            if (generation === this.generation) channel.send(result);
          })
          .catch(() => channel.close());
      }
    } catch {
      try {
        channel.send({ type: "auth-rejected" });
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      clearTimeout(authTimeout);
      channel.close();
    }
  }
  /** Paired phones see every project and session the desktop sidebar lists. */
  private allowedSession(sessionId: string) {
    const session = this.runtime.sessions().find((s) => s.id === sessionId);
    if (!session) throw new Error("SCOPE_DENIED");
    return session;
  }
  private runId(id: string) {
    const session = this.runtime.sessions().find((s) => s.id === id);
    if (!session || !["running", "stopping"].includes(session.status))
      return null;
    if (!this.runIds.has(id)) this.runIds.set(id, randomUUID());
    return this.runIds.get(id)!;
  }
  snapshot(
    sessionId?: string,
    before?: number,
    expectedHistoryRevision?: string,
  ) {
    const sessions = this.runtime
      .sessions()
      .map((s) => ({ ...s, runId: this.runId(s.id) }));
    const visible = new Set(sessions.map((s) => s.id));
    const permissions: RemotePermission[] = [];
    for (const [requestId, p] of this.permissions) {
      const runId = this.runId(p.sessionId);
      if (
        visible.has(p.sessionId) &&
        runId &&
        this.runtime.hasPermission(p.sessionId, p.toolUseId)
      )
        permissions.push({
          requestId,
          sessionId: p.sessionId,
          runId,
          toolName: p.toolName,
          detail: permissionDetail(p).length > 24000
            ? permissionDetail(p).slice(0, 24000) + "\n… Too long to show here. Review the full request on your Mac."
            : permissionDetail(p),
          canApprove: canApproveRemotely(p),
        });
    }
    let messages: RemoteMessage[] | undefined;
    let historyRevision: string | undefined;
    let cursor: number | null = null;
    if (sessionId) {
      this.allowedSession(sessionId);
      const merged = new Map(
        this.runtime.history(sessionId).map((m) => [m.id, m]),
      );
      for (const [id, message] of this.live.get(sessionId) ?? [])
        merged.set(id, message);
      const all = [...merged.values()];
      historyRevision = createHash("sha256")
        .update(JSON.stringify(all))
        .digest("hex");
      if (before !== undefined && expectedHistoryRevision !== historyRevision)
        throw new Error("HISTORY_CHANGED");
      const end = Math.min(before ?? all.length, all.length);
      let start = end;
      let bytes = 0;
      while (start > 0 && end - start < 100) {
        const size = Buffer.byteLength(JSON.stringify(all[start - 1]));
        if (bytes + size > 512 * 1024) break;
        bytes += size;
        start--;
      }
      messages = all.slice(start, end);
      cursor = start > 0 ? start : null;
    }
    const state = {
      projects: this.runtime
        .projects()
        .map(({ id, name, isRepo }) => ({ id, name, isRepo })),
      sessions,
      permissions,
      sessionId,
      messages,
      before: cursor,
      historyRevision,
    };
    return {
      ...state,
      protocol: REMOTE_PROTOCOL,
      hostBootId: this.hostBootId,
      machineName: hostname(),
      environment: this.runtime.environment ?? "development",
      serverTime: Date.now(),
      revision: createHash("sha256")
        .update(JSON.stringify(state))
        .digest("hex"),
    };
  }
  async dispatch(data: unknown, peerId: string): Promise<unknown> {
    const parsed = requestSchema.safeParse(data);
    const requestId =
      typeof (data as any)?.id === "string"
        ? (data as any).id.slice(0, 160)
        : "";
    if (!parsed.success)
      return { type: "response", id: requestId, error: "INVALID_REQUEST" };
    const request = parsed.data;
    try {
      if (
        !this.journal.state.devices.some((d) => d.peerId === peerId) ||
        !this.journal.state.config?.enabled
      )
        throw new Error("UNAUTHORIZED");
      if (request.method === "ping")
        return {
          type: "response",
          id: request.id,
          result: { serverTime: Date.now() },
        };
      if (request.method === "presence") {
        if (peerId === this.activePeer) this.peerAway = request.background;
        return { type: "response", id: request.id, result: { ok: true } };
      }
      if (request.method === "snapshot") {
        const result = this.snapshot(
          request.sessionId,
          request.before,
          request.historyRevision,
        );
        // Polls repeat every few seconds; an unchanged snapshot is not worth resending.
        return {
          type: "response",
          id: request.id,
          result:
            request.knownRevision && request.knownRevision === result.revision && request.before === undefined
              ? { unchanged: true, revision: result.revision, serverTime: result.serverTime }
              : result,
        };
      }
      if (request.method === "push.register") {
        const { deviceToken, topic, environment } = request;
        this.journal.update((s) => {
          for (const device of s.devices) {
            // A token belongs to one phone; drop it from any other device record.
            if (device.peerId === peerId) device.push = { deviceToken, topic, environment };
            else if (device.push?.deviceToken === deviceToken) delete device.push;
          }
        });
        return { type: "response", id: request.id, result: { ok: true } };
      }
      if (request.method === "options")
        return {
          type: "response",
          id: request.id,
          result: (await this.runtime.options?.()) ?? {},
        };
      if (request.method === "capabilities") {
        // A session answers for its own agent and folder; a new task for the project's.
        const session = request.sessionId ? this.allowedSession(request.sessionId) : undefined;
        const projectId = session?.projectId ?? request.projectId;
        const project = this.runtime.projects().find((p) => p.id === projectId);
        if (!project) throw new Error("SCOPE_DENIED");
        const provider = providerSchema.safeParse(session?.provider ?? request.provider);
        if (!provider.success) return { type: "response", id: request.id, result: { commands: [], skills: [] } };
        return {
          type: "response",
          id: request.id,
          result: (await this.runtime.capabilities?.(provider.data, project.path, session?.id)) ?? { commands: [], skills: [] },
        };
      }
      if (
        request.method === "files.list" ||
        request.method === "files.search" ||
        request.method === "files.read"
      ) {
        const project = this.runtime.projects().find((p) => p.id === request.projectId);
        if (!project) throw new Error("SCOPE_DENIED");
        let result;
        try {
          result =
            request.method === "files.list"
              ? await listProjectDir(project.path, request.path)
              : request.method === "files.search"
                ? await searchProjectFiles(project.path, request.query)
                : await readProjectFile(project.path, request.path);
        } catch (error) {
          // Only our own codes go back; fs messages would leak absolute paths.
          const code = error instanceof Error ? error.message : "";
          throw new Error(/^[A-Z_]+$/.test(code) ? code : "FILE_UNAVAILABLE");
        }
        return { type: "response", id: request.id, result };
      }
      if (request.method === "attachment.chunk")
        return {
          type: "response",
          id: request.id,
          result: await this.receiveChunk(request, peerId),
        };
      const key = peerId + ":" + request.commandId;
      if (request.method === "command.get")
        return {
          type: "response",
          id: request.id,
          result: this.journal.state.commands[key]?.result ?? null,
        };
      const { id: _id, ...payload } = request;
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(payload))
        .digest("hex");
      const existing = this.journal.state.commands[key];
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new Error("COMMAND_MISMATCH");
        return {
          type: "response",
          id: request.id,
          result: structuredClone(existing.result),
        };
      }
      if (
        request.expiresAt < Date.now() ||
        request.expiresAt > Date.now() + 305000
      )
        throw new Error("COMMAND_EXPIRED");
      const attachments =
        "attachmentIds" in request && request.attachmentIds?.length
          ? request.attachmentIds.map((attachmentId) => {
              const entry = this.uploaded.get(attachmentId);
              if (!entry || entry.peer !== peerId) throw new Error("ATTACHMENT_EXPIRED");
              return entry.attachment;
            })
          : undefined;
      if ("sessionId" in request) {
        const session = this.allowedSession(request.sessionId);
        if (!["claude", "codex", "bubble", "devin", "mimo"].includes(session.provider))
          throw new Error("DESKTOP_REQUIRED");
      }
      if (
        request.method === "create" &&
        !this.runtime.projects().some((p) => p.id === request.projectId)
      )
        throw new Error("SCOPE_DENIED");
      if ("runId" in request && request.runId !== this.runId(request.sessionId))
        throw new Error("STALE_RUN");
      if (
        request.method === "send" &&
        (this.runId(request.sessionId) ||
          this.pendingCommands.has("session:" + request.sessionId))
      )
        throw new Error("SESSION_BUSY");
      if (request.method === "permission") {
        const permission = this.permissions.get(request.requestId);
        if (
          !permission ||
          permission.sessionId !== request.sessionId ||
          !this.runtime.hasPermission(
            permission.sessionId,
            permission.toolUseId,
          )
        )
          throw new Error("PERMISSION_EXPIRED");
        if (
          request.decision === "allow" &&
          !canApproveRemotely(permission)
        )
          throw new Error("DESKTOP_REQUIRED");
      }
      const result: CommandResult = {
        commandId: request.commandId,
        state: "accepted",
        ...("sessionId" in request ? { sessionId: request.sessionId } : {}),
      };
      this.journal.update((s) => {
        for (const [id, entry] of Object.entries(s.commands))
          if (entry.expiresAt < Date.now() - 30 * 86400000)
            delete s.commands[id];
        s.commands[key] = { fingerprint, result, expiresAt: request.expiresAt };
      });
      this.pendingCommands.add(key);
      if (request.method === "send")
        this.pendingCommands.add("session:" + request.sessionId);
      try {
        if (request.method === "create") {
          const project = this.runtime
            .projects()
            .find((p) => p.id === request.projectId);
          if (!project) throw new Error("SCOPE_DENIED");
          const id = await this.runtime.start(
            project,
            request.provider,
            request.prompt,
            { settings: request.settings, worktree: request.worktree, attachments },
          );
          if (!id) throw new Error("START_FAILED");
          result.sessionId = id;
        } else if (request.method === "send") {
          if (
            !(await this.runtime.send(request.sessionId, request.prompt, {
              settings: request.settings,
              attachments,
            }))
          )
            throw new Error("SEND_FAILED");
        } else if (request.method === "stop")
          this.runtime.stop(request.sessionId);
        else if (request.method === "permission") {
          const permission = this.permissions.get(request.requestId);
          if (
            !permission ||
            permission.sessionId !== request.sessionId ||
            !this.runtime.hasPermission(
              permission.sessionId,
              permission.toolUseId,
            )
          )
            throw new Error("PERMISSION_EXPIRED");
          if (
            request.decision === "allow" &&
            !canApproveRemotely(permission)
          )
            throw new Error("DESKTOP_REQUIRED");
          if (!this.runtime.permission(permission, request.decision))
            throw new Error("PERMISSION_EXPIRED");
          this.permissions.delete(request.requestId);
        }
        result.state = "completed";
      } catch {
        result.state = "unknown";
        result.error = "Check the result on your Mac before sending this again.";
      } finally {
        this.pendingCommands.delete(key);
        if (request.method === "send")
          this.pendingCommands.delete("session:" + request.sessionId);
      }
      this.journal.update((s) => {
        s.commands[key].result = result;
      });
      this.invalidate();
      return { type: "response", id: request.id, result };
    } catch (error) {
      return {
        type: "response",
        id: request.id,
        error: error instanceof Error ? error.message : "REQUEST_FAILED",
      };
    }
  }
  private async receiveChunk(
    request: { uploadId: string; name: string; index: number; total: number; data: string },
    peer: string,
  ): Promise<RemoteAttachment | { received: number }> {
    if (!this.runtime.attach) throw new Error("UNSUPPORTED");
    const now = Date.now();
    for (const [key, upload] of this.uploads) if (now - upload.at > UPLOAD_TTL) this.uploads.delete(key);
    for (const [key, entry] of this.uploaded) if (now - entry.at > UPLOAD_TTL * 6) this.uploaded.delete(key);
    let upload = this.uploads.get(request.uploadId);
    if (!upload) {
      if (request.index !== 0) throw new Error("UPLOAD_EXPIRED");
      if ([...this.uploads.values()].filter((u) => u.peer === peer).length >= 4) throw new Error("TOO_MANY_UPLOADS");
      upload = { peer, name: request.name, total: request.total, parts: [], bytes: 0, at: now };
      this.uploads.set(request.uploadId, upload);
    }
    if (upload.peer !== peer || upload.total !== request.total || request.index !== upload.parts.length)
      throw new Error("UPLOAD_OUT_OF_ORDER");
    const part = Buffer.from(request.data, "base64");
    upload.bytes += part.length;
    if (upload.bytes > MAX_UPLOAD_BYTES) {
      this.uploads.delete(request.uploadId);
      throw new Error("ATTACHMENT_TOO_LARGE");
    }
    upload.parts.push(part);
    upload.at = now;
    if (upload.parts.length < upload.total) return { received: upload.parts.length };
    this.uploads.delete(request.uploadId);
    const attachment = await this.runtime.attach(upload.name, new Uint8Array(Buffer.concat(upload.parts)));
    const attachmentId = randomUUID();
    this.uploaded.set(attachmentId, { peer, attachment, at: now });
    return {
      attachmentId,
      name: attachment.name,
      size: attachment.size,
      kind: attachment.kind,
      mimeType: attachment.mimeType,
    };
  }
  capture(event: ServerEvent) {
    const p = event.payload as any;
    const id = p.sessionId as string | undefined;
    if (event.type === "stream.user_prompt" && id) {
      this.runIds.set(id, randomUUID());
      this.live.delete(id);
      for (const [key, value] of this.permissions)
        if (value.sessionId === id) this.permissions.delete(key);
    }
    if (event.type === "stream.message" && id) {
      const message = p.message;
      if (
        message.type === "stream_event" &&
        message.event?.delta?.type === "text_delta" &&
        typeof message.event.delta.text === "string"
      ) {
        const messages = this.live.get(id) ?? new Map<string, RemoteMessage>();
        const key = id + ":live";
        const text = (messages.get(key)?.text ?? "") + message.event.delta.text;
        messages.set(key, {
          id: key,
          role: "assistant",
          text: text.slice(-64000),
          streaming: true,
        });
        this.live.set(id, messages);
      } else if (message.type === "assistant" && !message.streaming)
        this.live.delete(id);
    }
    if (event.type === "permission.request" && id) this.notify("approval", id);
    if (event.type === "session.status" && id) {
      if (["running", "stopping"].includes(p.status)) this.running.add(id);
      else if (this.running.delete(id)) this.notify(p.status === "error" ? "failed" : "finished", id);
    }
    if (event.type === "permission.request")
      this.permissions.set(
        this.hostBootId + ":" + p.sessionId + ":" + p.toolUseId,
        event.payload,
      );
    if (event.type === "permission.dismissed")
      this.permissions.delete(
        this.hostBootId + ":" + p.sessionId + ":" + p.toolUseId,
      );
    if (
      event.type === "session.status" &&
      id &&
      !["running", "stopping"].includes(p.status)
    ) {
      this.runIds.delete(id);
      this.live.delete(id);
    }
    if (
      event.type.startsWith("session.") ||
      event.type.startsWith("stream.") ||
      event.type.startsWith("permission.")
    )
      this.invalidate();
  }
  /** Tells paired phones through APNs, only while none is connected to see it live. */
  private notify(kind: "approval" | "finished" | "failed", sessionId: string) {
    const config = this.journal.state.config;
    // A phone that is connected and on screen sees it live; one that is off screen still gets the push.
    const away = this.status === "connected" && this.peerAway;
    if (!config?.enabled || (this.status !== "waiting" && !away)) return;
    const session = this.runtime.sessions().find((s) => s.id === sessionId);
    if (!session) return;
    const key = kind + ":" + sessionId;
    const now = Date.now();
    if (now - (this.notified.get(key) ?? 0) < 60000) return;
    this.notified.set(key, now);
    for (const [k, at] of this.notified) if (now - at > 600000) this.notified.delete(k);
    for (const device of this.journal.state.devices) {
      const push = device.push;
      if (!push) continue;
      void this.deliver(config.relay, config.identity, device.peerId, { ...push, kind, sessionId, machineName: hostname().slice(0, 100) });
    }
  }
  private async deliver(
    relay: string,
    identity: string,
    peerId: string,
    fields: Parameters<typeof pushRequest>[1],
  ) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // Re-sign every attempt: the relay rejects reused nonces.
        const { body, signature } = pushRequest(identity, fields);
        const res = await fetch(relayHttpOrigin(relay) + "/v1/push", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Aegis-Signature": signature },
          body,
          signal: AbortSignal.timeout(15000),
        });
        const result = (await res.json().catch(() => ({}))) as { unregistered?: boolean };
        if (result.unregistered)
          this.journal.update((s) => {
            const device = s.devices.find((d) => d.peerId === peerId);
            if (device?.push?.deviceToken === fields.deviceToken) delete device.push;
          });
        // Only network trouble and relay/APNs hiccups are worth another try.
        if (res.status < 500 || res.status === 503) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 2000 * 4 ** attempt));
    }
  }
  private invalidate() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try {
        this.channel?.send({ type: "changed" });
      } catch {}
    }, 180);
  }
}

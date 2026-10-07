import { z } from "zod";

export const REMOTE_PROTOCOL = "aegis.remote.v1";
export const environmentSchema = z.enum(["development", "production", "fixture"]);
export type RemoteEnvironment = z.infer<typeof environmentSchema>;
export const environmentLabel = (value: RemoteEnvironment) =>
  ({ development: "Aegis Dev", production: "Aegis", fixture: "Fixture" })[value];
export const providerSchema = z.enum(["claude", "codex", "bubble", "devin", "mimo"]);
const id = z.string().min(1).max(160);
const short = z.string().trim().min(1).max(120);
/**
 * Per-task agent settings, mirroring the desktop composer. Values are open
 * strings validated by the host against its own catalog (efforts and model
 * ids come from provider runtimes, never from a list baked into the phone).
 */
export const taskSettingsSchema = z
  .object({
    model: z.string().trim().max(200).optional(),
    compatibleProviderId: short.optional(),
    effort: short.optional(),
    fast: z.boolean().optional(),
    permissionMode: short.optional(),
    plan: z.boolean().optional(),
  })
  .strict();
export type RemoteTaskSettings = z.infer<typeof taskSettingsSchema>;
const attachmentIds = z.array(id).max(10).optional();
/** Upload chunks stay well under the relay's 256 KB message cap. */
export const ATTACHMENT_CHUNK_BYTES = 96 * 1024;
export const requestSchema = z.discriminatedUnion("method", [
  z.object({ id, method: z.literal("ping") }).strict(),
  z
    .object({
      id,
      method: z.literal("snapshot"),
      sessionId: id.optional(),
      before: z.number().int().nonnegative().optional(),
      historyRevision: id.optional(),
    })
    .strict(),
  z.object({ id, method: z.literal("command.get"), commandId: id }).strict(),
  z.object({ id, method: z.literal("options") }).strict(),
  z
    .object({
      id,
      method: z.literal("push.register"),
      deviceToken: z.string().regex(/^[a-f0-9]{64,200}$/),
      // The app's bundle id; the relay decides which topics it serves.
      topic: z.string().regex(/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/).max(155),
      environment: z.enum(["development", "production"]),
    })
    .strict(),
  // Read-only browsing of an authorized project's files.
  z
    .object({ id, method: z.literal("files.list"), projectId: id, path: z.string().max(1024).optional() })
    .strict(),
  z
    .object({ id, method: z.literal("files.search"), projectId: id, query: z.string().trim().min(1).max(200) })
    .strict(),
  z
    .object({ id, method: z.literal("files.read"), projectId: id, path: z.string().min(1).max(1024) })
    .strict(),
  z
    .object({
      id,
      method: z.literal("attachment.chunk"),
      uploadId: id,
      name: z.string().trim().min(1).max(255),
      index: z.number().int().nonnegative().max(200),
      total: z.number().int().positive().max(200),
      data: z.string().max(Math.ceil((ATTACHMENT_CHUNK_BYTES * 4) / 3) + 8),
    })
    .strict(),
  z
    .object({
      id,
      method: z.literal("create"),
      commandId: id,
      expiresAt: z.number(),
      projectId: id,
      provider: providerSchema,
      prompt: z.string().trim().min(1).max(32000),
      settings: taskSettingsSchema.optional(),
      worktree: z.boolean().optional(),
      attachmentIds,
    })
    .strict(),
  z
    .object({
      id,
      method: z.literal("send"),
      commandId: id,
      expiresAt: z.number(),
      sessionId: id,
      prompt: z.string().trim().min(1).max(32000),
      settings: taskSettingsSchema.optional(),
      attachmentIds,
    })
    .strict(),
  z
    .object({
      id,
      method: z.literal("stop"),
      commandId: id,
      expiresAt: z.number(),
      sessionId: id,
      runId: id,
    })
    .strict(),
  z
    .object({
      id,
      method: z.literal("permission"),
      commandId: id,
      expiresAt: z.number(),
      sessionId: id,
      runId: id,
      requestId: id,
      decision: z.enum(["allow", "deny"]),
    })
    .strict(),
]);
export type RemoteRequest = z.infer<typeof requestSchema>;
export type RemoteMutation = Extract<
  RemoteRequest,
  { commandId: string; expiresAt: number }
>;
export type RemoteProvider = z.infer<typeof providerSchema>;
export interface RemoteProject {
  id: string;
  name: string;
  /** Git repository: the desktop heading says "build" instead of "work on". */
  isRepo?: boolean;
}
/** Secret-free agent catalog from the host; the phone builds pickers from it. */
export interface RemoteAgentOptions {
  claude?: {
    defaultModel: string | null;
    options: string[];
    /** Enabled Claude-compatible providers (no endpoints or keys). */
    compatible: Array<{ id: string; model: string }>;
  };
  codex?: {
    defaultModel: string | null;
    defaultReasoningEffort: string | null;
    options: string[];
    availableModels: Array<{
      name: string;
      label?: string;
      enabled: boolean;
      isDefault: boolean;
      priority?: number | null;
      defaultReasoningEffort?: string | null;
      supportedReasoningLevels?: Array<{ effort: string; description?: string }>;
      supportsFastMode?: boolean;
    }>;
  };
  devin?: {
    defaultModel: string | null;
    availableModels: Array<{ id: string; label: string }>;
    /** Per model id; models whose levels could not be read are absent. */
    thoughtLevels: Record<string, RemoteDevinThoughtLevels>;
  };
  mimo?: {
    defaultModel: string | null;
    /** Reasoning levels are each model's variants; none means no control. */
    availableModels: Array<{ id: string; label: string; reasoningEfforts: string[] }>;
  };
  bubble?: {
    defaultModel: string | null;
    options: string[];
    availableModels: Array<{
      name: string;
      label?: string;
      provider?: string | null;
      enabled: boolean;
      isDefault: boolean;
      reasoningLevels?: string[];
      defaultReasoningLevel?: string | null;
    }>;
  };
}
export interface RemoteFileEntry {
  name: string;
  /** Relative to the project root, with forward slashes. */
  path: string;
  kind: "dir" | "file";
}
export interface RemoteFileContent {
  path: string;
  size: number;
  /** Null for binary files. */
  text: string | null;
  truncated: boolean;
}
/** Devin thinking levels for one model; empty when the model has none. */
export interface RemoteDevinThoughtLevels {
  levels: Array<{ id: string; label: string }>;
  defaultLevel: string | null;
}
export interface RemoteAttachment {
  attachmentId: string;
  name: string;
  size: number;
  kind: "file" | "image";
  mimeType: string;
}
export interface RemoteSession {
  id: string;
  projectId: string;
  title: string;
  provider: string;
  status: string;
  updatedAt: number;
  runId: string | null;
  /** Provider the session was handed off from, when it changed agents. */
  handoffSourceProvider?: string | null;
  /** The session's current agent settings, used as follow-up defaults. */
  settings?: RemoteTaskSettings;
}
export interface RemoteMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  streaming?: boolean;
  /** Host timestamp (ms) when known. */
  at?: number;
  /**
   * Size-bounded copy of the desktop stream message. The phone rebuilds the
   * desktop trace from these; `text` stays as a fallback for older hosts.
   */
  raw?: unknown;
}
export interface RemotePermission {
  requestId: string;
  sessionId: string;
  runId: string;
  toolName: string;
  detail: string;
  canApprove: boolean;
}
export interface RemoteSnapshot {
  protocol: typeof REMOTE_PROTOCOL;
  hostBootId: string;
  machineName: string;
  environment: RemoteEnvironment;
  serverTime: number;
  projects: RemoteProject[];
  sessions: RemoteSession[];
  permissions: RemotePermission[];
  sessionId?: string;
  messages?: RemoteMessage[];
  before?: number | null;
  revision: string;
  historyRevision?: string;
}
export interface CommandResult {
  commandId: string;
  state: "accepted" | "completed" | "rejected" | "unknown";
  sessionId?: string;
  error?: string;
}
export const pairingSchema = z
  .object({
    version: z.literal(1),
    environment: environmentSchema,
    relay: z.string().url(),
    room: z.string().regex(/^[a-f0-9]{32}$/),
    routeToken: z.string().min(32).max(128),
    hostPeerId: z.string().min(20).max(160),
    invite: z.string().min(32).max(128).optional(),
    expiresAt: z.number().optional(),
    name: z.string().max(100),
  })
  .strict();
export type Pairing = z.infer<typeof pairingSchema>;
export function parsePairing(value: string): Pairing {
  const raw = value.trim();
  const data = pairingSchema.parse(
    JSON.parse(
      raw.startsWith("{")
        ? raw
        : decodeURIComponent(new URL(raw).hash.slice(1)),
    ),
  );
  const url = new URL(data.relay);
  if (
    url.protocol !== "wss:" &&
    !(
      url.protocol === "ws:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error("中继必须使用 WSS");
  if (data.invite && (!data.expiresAt || data.expiresAt < Date.now()))
    throw new Error("配对码已过期，请在电脑重新生成");
  return data;
}

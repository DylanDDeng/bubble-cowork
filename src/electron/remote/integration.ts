import { app, dialog, safeStorage, type BrowserWindow } from "electron";
import { existsSync } from "fs";
import { basename, join } from "path";
import { createHash } from "crypto";
import * as sessions from "../libs/session-store";
import { canonicalProjectPath } from "../libs/project-paths";
import { ipcMainHandle } from "../util";
import { RemoteGateway, type RemoteRuntime } from "./gateway";
import { RemoteJournal } from "./journal";
import { defaultRelay } from "./relay-auth";
import { projectMessages } from "../../shared/remote/projection";
import type { RemoteAgentOptions } from "../../shared/remote/protocol";
import type { ServerEvent } from "../../shared/types";
export { remoteTaskPayload } from "./task-payload";
import { getClaudeModelConfigWithCatalog } from "../libs/claude-settings";
import { loadCompatibleProviderConfig } from "../libs/compatible-provider-config";
import { getCodexModelConfig } from "../libs/codex-settings";
import { getBubbleModelConfig } from "../libs/bubble-settings";
import { getDevinModelConfig, getDevinThoughtLevels } from "../libs/devin-cli";
import { getMimoModelConfig } from "../libs/mimo-cli";
import { importAttachmentBytes } from "../libs/file-attachments";
import { composerCapabilities } from "./capabilities";
export { codexReferences } from "./capabilities";

/** Devin's catalog with thinking levels per model (both cached by devin-cli). */
async function devinOptions(): Promise<RemoteAgentOptions["devin"] | null> {
  const config = await getDevinModelConfig();
  if (!config.availableModels.length) return null;
  const thoughtLevels: NonNullable<RemoteAgentOptions["devin"]>["thoughtLevels"] = {};
  // Each uncached model is probed through Devin's ACP session; stop waiting
  // after a few seconds so the phone's pickers still load.
  await Promise.race([
    Promise.all(
      config.availableModels.map(async ({ id }) => {
        const levels = await getDevinThoughtLevels(id);
        thoughtLevels[id] = { levels: levels.levels, defaultLevel: levels.defaultLevel };
      }),
    ),
    new Promise((resolve) => setTimeout(resolve, 8000)),
  ]);
  return { defaultModel: config.defaultModel, availableModels: config.availableModels, thoughtLevels };
}

/** MiMo's catalog; reasoning levels ride on each model (cached by mimo-cli). */
async function mimoOptions(): Promise<RemoteAgentOptions["mimo"] | null> {
  const config = await getMimoModelConfig();
  if (!config.availableModels.length) return null;
  return {
    defaultModel: config.defaultModel,
    availableModels: config.availableModels.map(({ id, label, reasoningEfforts }) => ({ id, label, reasoningEfforts })),
  };
}

async function agentOptions(): Promise<RemoteAgentOptions> {
  const [claude, bubble, devin, mimo] = await Promise.all([
    getClaudeModelConfigWithCatalog().catch(() => null),
    getBubbleModelConfig().catch(() => null),
    devinOptions().catch(() => null),
    mimoOptions().catch(() => null),
  ]);
  let codex: ReturnType<typeof getCodexModelConfig> | null = null;
  try {
    codex = getCodexModelConfig();
  } catch {
    codex = null;
  }
  let compatible: Array<{ id: string; model: string }> = [];
  try {
    // Only ids and model names leave the Mac; endpoints and keys stay here.
    compatible = Object.entries(loadCompatibleProviderConfig().providers)
      .filter(([, p]) => p.enabled && p.secret?.trim() && p.model?.trim())
      .map(([id, p]) => ({ id, model: p.model.trim() }));
  } catch {
    compatible = [];
  }
  return {
    ...(claude ? { claude: { defaultModel: claude.defaultModel, options: claude.options, compatible } } : {}),
    ...(codex
      ? {
          codex: {
            defaultModel: codex.defaultModel,
            defaultReasoningEffort: codex.defaultReasoningEffort,
            options: codex.options,
            availableModels: codex.availableModels.map((m) => ({
              name: m.name,
              label: m.label,
              enabled: m.enabled,
              isDefault: m.isDefault,
              defaultReasoningEffort: m.defaultReasoningEffort,
              supportedReasoningLevels: m.supportedReasoningLevels,
              supportsFastMode: m.supportsFastMode,
              priority: m.priority,
            })),
          },
        }
      : {}),
    ...(devin ? { devin } : {}),
    ...(mimo ? { mimo } : {}),
    ...(bubble
      ? {
          bubble: {
            defaultModel: bubble.defaultModel,
            options: bubble.options,
            availableModels: bubble.availableModels.map((m) => ({
              name: m.name,
              label: m.label,
              provider: m.provider,
              enabled: m.enabled,
              isDefault: m.isDefault,
              reasoningLevels: m.reasoningLevels,
              defaultReasoningLevel: m.defaultReasoningLevel,
            })),
          },
        }
      : {}),
  };
}
let gateway: RemoteGateway | undefined;
export function captureRemoteEvent(event: ServerEvent) {
  gateway?.capture(event);
}
export function closeRemoteGateway() {
  gateway?.close();
}
export function setupRemoteIPC(
  window: BrowserWindow,
  actions: Pick<
    RemoteRuntime,
    "start" | "send" | "stop" | "permission" | "hasPermission"
  >,
) {
  const file = join(app.getPath("userData"), "remote-companion.enc");
  const projectId = (path: string) =>
    createHash("sha256")
      .update(canonicalProjectPath(path))
      .digest("hex")
      .slice(0, 32);
  const listProjects = () =>
    [
      ...new Set(
        sessions
          .listSessions()
          .filter((s) => s.hidden_from_threads !== 1)
          .map((s) => s.project_cwd || s.cwd)
          .filter((p): p is string => !!p),
      ),
    ].map((path) => ({
      id: projectId(path),
      name: basename(path),
      path,
      isRepo: existsSync(join(path, ".git")),
    }));
  const get = () => {
    if (gateway) return gateway;
    if (!safeStorage.isEncryptionAvailable())
      throw new Error("System keychain is unavailable");
    const journal = new RemoteJournal(
      file,
      (value) => safeStorage.encryptString(value).toString("base64"),
      (value) => safeStorage.decryptString(Buffer.from(value, "base64")),
    );
    gateway = new RemoteGateway(journal, {
      ...actions,
      environment: app.isPackaged ? "production" : "development",
      projects: listProjects,
      options: agentOptions,
      capabilities: (provider, projectPath, sessionId) => {
        // A worktree session's own folder holds its project skills.
        const cwd = (sessionId && sessions.getSession(sessionId)?.cwd) || projectPath;
        return composerCapabilities(provider, cwd, sessionId ? sessions.getSessionHistory(sessionId) : []);
      },
      attach: (name, data) => importAttachmentBytes(name, data),
      sessions: () => {
        // The desktop sidebar's list: archived sessions stay off the phone too.
        const organization = sessions.getSessionOrganization().sessions;
        return sessions
          .listSessions()
          .filter(
            (s) =>
              s.hidden_from_threads !== 1 &&
              !!s.cwd &&
              s.session_origin === "aegis" &&
              !organization[s.id]?.archived,
          )
          .map((s) => ({
            id: s.id,
            projectId: projectId(s.project_cwd || s.cwd!),
            title: s.title,
            provider: s.provider || "claude",
            status: s.status,
            updatedAt: s.updated_at,
            runId: null,
            handoffSourceProvider: s.handoff_source_provider,
            pinned: s.pinned === 1,
            settings: {
              model: s.model || undefined,
              compatibleProviderId: s.compatible_provider_id || undefined,
              effort: (s.provider === "codex" ? s.codex_reasoning_effort : s.provider === "claude" ? s.claude_reasoning_effort : null) || undefined,
              fast: s.provider === "codex" && s.codex_fast_mode != null ? s.codex_fast_mode === 1 : undefined,
              permissionMode: (s.provider === "codex" ? s.codex_permission_mode : s.provider === "claude" ? s.claude_access_mode : null) || undefined,
              plan: (s.provider === "codex" ? s.codex_execution_mode : s.provider === "claude" ? s.claude_execution_mode : null) === "plan" || undefined,
            },
          }));
      },
      history: (id) => projectMessages(sessions.getSessionHistory(id)),
      confirm: async (name, peerId) => {
        const result = await dialog.showMessageBox(window, {
          type: "question",
          title: "Connect iPhone",
          message: `Allow “${name}” to use Aegis on this Mac?`,
          detail: `Check that your iPhone shows this device ID:\n${peerId}\n\nOnce allowed, it can see all your projects and sessions, start and stop tasks, and answer one-time approvals.`,
          buttons: ["Don’t Allow", "Allow This iPhone"],
          defaultId: 0,
          cancelId: 0,
        });
        return result.response === 1;
      },
    });
    return gateway;
  };
  ipcMainHandle(
    "remote-companion",
    async (_event, action: string, payload: any) => {
      switch (action) {
        case "status":
          return gateway
            ? gateway.describe()
            : {
                status: "disabled",
                enabled: false,
                environment: app.isPackaged ? "production" : "development",
                relay: "",
                defaultRelay: defaultRelay(),
                projects: listProjects().map(({ id, name }) => ({ id, name })),
                devices: [],
              };
        case "configure":
          if (typeof payload?.relay !== "string" || typeof payload?.token !== "string")
            throw new Error("Invalid remote configuration");
          return get().configure(payload.relay, payload.token);
        case "pair": {
          const offer = get().pairing();
          const url =
            (app.isPackaged ? "aegis://pair#" : "aegis-dev://pair#") +
            encodeURIComponent(JSON.stringify(offer));
          const QRCode = require("qrcode");
          return {
            url,
            qr: await QRCode.toDataURL(url, { width: 280, margin: 2 }),
            expiresAt: offer.expiresAt,
          };
        }
        case "revoke":
          if (typeof payload?.peerId !== "string")
            throw new Error("Invalid device");
          return get().revoke(payload.peerId);
        case "disable":
          return get().disable();
        default:
          throw new Error("Unknown remote action");
      }
    },
  );
  if (existsSync(file)) {
    try {
      get().connect();
    } catch {
      console.warn("Remote companion disabled: key store could not be opened");
    }
  }
}

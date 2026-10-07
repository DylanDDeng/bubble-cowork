// Wires the Feishu bridge into the app: encrypted state, the connection
// lifecycle, QR setup, the settings IPC, and the session runtime.
import { app, safeStorage } from "electron";
import { existsSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { randomInt } from "crypto";
import * as sessions from "../libs/session-store";
import { canonicalProjectPath } from "../libs/project-paths";
import { importAttachmentBytes } from "../libs/file-attachments";
import { getAppPreferences } from "../libs/app-preferences";
import { ipcMainHandle } from "../util";
import type { FeishuStatus, PermissionResult, ServerEvent, SessionStartPayload } from "../../shared/types";
import { FeishuBridge } from "./bridge";
import { connectChannel, registerWithQr } from "./channel";
import { FeishuStore, type FeishuDomain } from "./store";
import { readDesktopPreferences } from "./agent-settings";

export interface FeishuActions {
  start(payload: SessionStartPayload, onCreated: (sessionId: string) => void): Promise<string | null>;
  send(sessionId: string, prompt: string, attachments?: SessionStartPayload["attachments"]): Promise<boolean>;
  stop(sessionId: string): void;
  respond(sessionId: string, toolUseId: string, result: PermissionResult): boolean;
}

let bridge: FeishuBridge | undefined;
let store: FeishuStore | undefined;
let channel: Awaited<ReturnType<typeof connectChannel>>["channel"] | undefined;
let connection: FeishuStatus["connection"] = "off";
let lastError = "";
let botName = "";
let generation = 0;
let registration: { qr?: string; expiresAt?: number; state: "waiting" | "error"; error?: string; abort: AbortController } | undefined;

export function captureFeishuEvent(event: ServerEvent) {
  try {
    bridge?.capture(event);
  } catch (error) {
    console.warn("[feishu] event handling failed", error);
  }
}

export function isFeishuBound(sessionId: string) {
  return bridge?.isBound(sessionId) ?? false;
}

export async function closeFeishu() {
  generation++;
  registration?.abort.abort();
  bridge?.attach(undefined);
  bridge?.close();
  await channel?.disconnect().catch(() => {});
  channel = undefined;
}

/** One-time move of the old plaintext config and bindings into the encrypted store. */
function migrateLegacy(target: FeishuStore) {
  const dir = app.getPath("userData");
  const configFile = join(dir, "feishu-bridge.json");
  const bindingsFile = join(dir, "feishu-bridge-bindings.json");
  if (!existsSync(configFile) && !existsSync(bindingsFile)) return;
  try {
    const old = existsSync(configFile) ? (JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>) : {};
    const oldBindings = existsSync(bindingsFile)
      ? ((JSON.parse(readFileSync(bindingsFile, "utf8")) as { bindings?: { chatId?: string; sessionId?: string }[] }).bindings ?? [])
      : [];
    target.update((s) => {
      if (!s.credentials && typeof old.appId === "string" && old.appId && typeof old.appSecret === "string" && old.appSecret)
        s.credentials = { appId: old.appId, appSecret: old.appSecret, domain: "feishu" };
      if (!s.defaultCwd && typeof old.defaultCwd === "string" && old.defaultCwd) s.defaultCwd = old.defaultCwd;
      if (typeof old.allowedUserIds === "string")
        for (const id of old.allowedUserIds.split(/[\s,]+/).filter(Boolean))
          if (!s.allowedUsers.some((u) => u.openId === id)) s.allowedUsers.push({ openId: id });
      s.enabled = s.enabled || (old.enabled === true && old.autoStart === true);
      for (const b of oldBindings)
        if (b.chatId && b.sessionId && !s.bindings[b.chatId]) s.bindings[b.chatId] = { chatId: b.chatId, sessionId: b.sessionId, updatedAt: Date.now() };
    });
    rmSync(configFile, { force: true });
    rmSync(bindingsFile, { force: true });
  } catch (error) {
    console.warn("[feishu] could not migrate the old bridge settings", error);
  }
}

function projects() {
  return [
    ...new Set(
      sessions
        .listSessions()
        .filter((s) => s.hidden_from_threads !== 1)
        .map((s) => s.project_cwd || s.cwd)
        .filter((p): p is string => !!p)
        .map((p) => canonicalProjectPath(p)),
    ),
  ].map((path) => ({ path, name: basename(path) }));
}

async function connect() {
  const mine = ++generation;
  await channel?.disconnect().catch(() => {});
  channel = undefined;
  bridge?.attach(undefined);
  const state = store?.state;
  if (!bridge || !state?.enabled || !state.credentials) {
    connection = "off";
    return;
  }
  connection = "connecting";
  lastError = "";
  try {
    const connected = await connectChannel(state.credentials, {
      message: (msg) => void bridge?.handleMessage(msg).catch((e) => console.warn("[feishu] message failed", e)),
      cardAction: (evt) => bridge?.handleCardAction(evt),
      state: (next, detail) => {
        if (mine !== generation) return;
        connection = next;
        if (detail) lastError = detail;
      },
    });
    if (mine !== generation) {
      await connected.channel.disconnect().catch(() => {});
      return;
    }
    channel = connected.channel;
    bridge.attach(connected.transport);
    connection = "connected";
    try {
      botName = connected.channel.getBotIdentity().name;
    } catch {}
    if (!store!.state.ownerOpenId) {
      const owner = (await connected.channel.getAppInfo().catch(() => undefined))?.ownerId;
      if (owner) store!.update((s) => (s.ownerOpenId = owner));
      else bridge.claimCode = String(randomInt(100000, 1000000));
    }
  } catch (error) {
    if (mine !== generation) return;
    connection = "error";
    lastError = error instanceof Error ? error.message : String(error);
  }
}

function status(): FeishuStatus {
  const state = store?.state;
  return {
    connection,
    error: lastError || undefined,
    enabled: state?.enabled ?? false,
    configured: !!state?.credentials,
    appId: state?.credentials?.appId,
    domain: state?.credentials?.domain ?? "feishu",
    botName: botName || undefined,
    hasOwner: !!state?.ownerOpenId,
    claimCode: !state?.ownerOpenId ? bridge?.claimCode : undefined,
    defaultCwd: state?.defaultCwd,
    projects: projects(),
    allowedUsers: state?.allowedUsers ?? [],
    allowedChats: state?.allowedChats ?? [],
    bindings: Object.entries(state?.bindings ?? {}).map(([scope, b]) => ({
      scope,
      chatId: b.chatId,
      topic: !!b.threadId,
      sessionId: b.sessionId,
      title: sessions.getSession(b.sessionId)?.title ?? "Deleted task",
    })),
    registration: registration ? { state: registration.state, qr: registration.qr, expiresAt: registration.expiresAt, error: registration.error } : undefined,
  };
}

export function setupFeishu(actions: FeishuActions) {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn("[feishu] disabled: secure storage is unavailable");
    return;
  }
  store = new FeishuStore(
    join(app.getPath("userData"), "feishu.enc"),
    (v) => safeStorage.encryptString(v).toString("base64"),
    (v) => safeStorage.decryptString(Buffer.from(v, "base64")),
  );
  migrateLegacy(store);
  const rendererState = join(app.getPath("userData"), "renderer-state.json");
  bridge = new FeishuBridge(
    store,
    {
      ...actions,
      projects,
      session: (id) => {
        const row = sessions.getSession(id);
        return row ? { id: row.id, title: row.title, provider: row.provider || "claude", status: row.status, cwd: row.cwd } : undefined;
      },
      recentSessions: (cwd) => {
        const root = canonicalProjectPath(cwd);
        return sessions
          .listSessions()
          .filter((s) => s.hidden_from_threads !== 1 && canonicalProjectPath(s.project_cwd || s.cwd || "") === root)
          .sort((a, b) => b.updated_at - a.updated_at)
          .map((s) => ({ id: s.id, title: s.title, provider: s.provider || "claude", status: s.status, updatedAt: s.updated_at }));
      },
      attach: (name, data) => importAttachmentBytes(name, data),
      desktopPreferences: () => readDesktopPreferences(rendererState),
      followUp: () => getAppPreferences().followUpBehavior,
      tmpDir: () => join(tmpdir(), "aegis-feishu"),
    },
    (message) => console.warn("[feishu]", message),
  );
  void connect();

  ipcMainHandle("feishu", async (_event, action: string, payload: Record<string, unknown> | undefined) => {
    const s = store!;
    switch (action) {
      case "status":
        return status();
      case "register": {
        registration?.abort.abort();
        const abort = new AbortController();
        const current: NonNullable<typeof registration> = { state: "waiting", abort };
        registration = current;
        const urlReady = new Promise<void>((resolve) => {
          void registerWithQr({
            domain: (payload?.domain as FeishuDomain) || "feishu",
            signal: abort.signal,
            onUrl: (url, expiresIn) => {
              current.expiresAt = Date.now() + expiresIn * 1000;
              const QRCode = require("qrcode");
              void QRCode.toDataURL(url, { width: 280, margin: 2 })
                .then((qr: string) => (current.qr = qr))
                .finally(resolve);
            },
          })
            .then(async (result) => {
              if (registration !== current) return;
              registration = undefined;
              s.update((st) => {
                st.credentials = { appId: result.appId, appSecret: result.appSecret, domain: result.domain };
                if (result.ownerOpenId) st.ownerOpenId = result.ownerOpenId;
                st.enabled = true;
              });
              await connect();
            })
            .catch((error) => {
              if (registration !== current || abort.signal.aborted) return;
              current.state = "error";
              current.error = error instanceof Error ? error.message : String(error);
              resolve();
            });
        });
        await Promise.race([urlReady, new Promise((r) => setTimeout(r, 15000))]);
        return status();
      }
      case "cancel-register":
        registration?.abort.abort();
        registration = undefined;
        return status();
      case "save-credentials": {
        const appId = String(payload?.appId ?? "").trim();
        const appSecret = String(payload?.appSecret ?? "").trim();
        const domain: FeishuDomain = payload?.domain === "lark" ? "lark" : "feishu";
        if (!/^cli_[A-Za-z0-9]+$/.test(appId) || appSecret.length < 16) throw new Error("Enter a valid App ID and App Secret.");
        s.update((st) => {
          if (st.credentials?.appId !== appId) {
            // A different app has different users and chats.
            st.ownerOpenId = undefined;
            st.bindings = {};
            st.allowedUsers = [];
            st.allowedChats = [];
          }
          st.credentials = { appId, appSecret, domain };
          st.enabled = true;
        });
        await connect();
        return status();
      }
      case "set-enabled":
        s.update((st) => (st.enabled = payload?.enabled === true));
        await (payload?.enabled === true ? connect() : closeFeishu().then(() => (connection = "off")));
        return status();
      case "reconnect":
        await connect();
        return status();
      case "set-default-cwd":
        s.update((st) => (st.defaultCwd = typeof payload?.cwd === "string" && payload.cwd ? payload.cwd : undefined));
        return status();
      case "remove-user":
        s.update((st) => (st.allowedUsers = st.allowedUsers.filter((u) => u.openId !== payload?.openId)));
        return status();
      case "remove-chat":
        s.update((st) => (st.allowedChats = st.allowedChats.filter((c) => c.chatId !== payload?.chatId)));
        return status();
      case "unbind":
        if (typeof payload?.scope === "string") bridge!.unbind(payload.scope);
        return status();
      case "forget":
        await closeFeishu();
        connection = "off";
        s.update((st) => {
          st.credentials = undefined;
          st.ownerOpenId = undefined;
          st.enabled = false;
          st.bindings = {};
          st.allowedUsers = [];
          st.allowedChats = [];
          st.prefs = {};
        });
        return status();
      default:
        throw new Error("Unknown Feishu action");
    }
  });
}

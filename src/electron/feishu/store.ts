// Feishu bridge state: credentials, access lists, chat ↔ session bindings and
// per-chat agent choices. Written atomically and encrypted by the caller's
// codec (Electron safeStorage in the app, identity in tests).
import { randomBytes } from "crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";

export type FeishuDomain = "feishu" | "lark";

/** Agent choices a chat made with /agent or /project; unset fields follow the desktop. */
export interface ScopePrefs {
  cwd?: string;
  provider?: string;
  model?: string;
  permissionMode?: string;
}

export interface Binding {
  sessionId: string;
  chatId: string;
  threadId?: string;
  /** First message of a topic: replies for turns started on the desktop go under it. */
  anchorMessageId?: string;
  updatedAt: number;
}

/** A card still showing a live state; closed on the next start if Aegis quit first. */
export interface OpenCard {
  kind: "turn" | "prompt";
  target: { chatId: string; replyTo?: string; replyInThread?: boolean };
  /** Turns: the last rendered card, so the restart note keeps what was shown. */
  card?: object;
  /** Prompts: the card title. */
  title?: string;
  reactions?: { messageId: string; reactionId: string }[];
}

export interface FeishuState {
  version: 1;
  enabled: boolean;
  credentials?: { appId: string; appSecret: string; domain: FeishuDomain };
  /** open_id of the person who created the app (or set as owner); always allowed. */
  ownerOpenId?: string;
  defaultCwd?: string;
  allowedUsers: { openId: string; name?: string }[];
  allowedChats: { chatId: string; name?: string }[];
  bindings: Record<string, Binding>;
  prefs: Record<string, ScopePrefs>;
  /** HMAC key for card button tokens. */
  callbackKey: string;
  /** Spent single-use button nonces → expiry (ms). */
  usedNonces: Record<string, number>;
  /** Cards showing a run or a pending request, by card id. */
  openCards: Record<string, OpenCard>;
}

export const emptyState = (): FeishuState => ({
  version: 1,
  enabled: false,
  allowedUsers: [],
  allowedChats: [],
  bindings: {},
  prefs: {},
  callbackKey: randomBytes(32).toString("hex"),
  usedNonces: {},
  openCards: {},
});

export class FeishuStore {
  state: FeishuState;

  constructor(
    private file: string,
    private encode: (data: string) => string,
    private decode: (data: string) => string,
  ) {
    this.state = existsSync(file) ? { ...emptyState(), ...JSON.parse(decode(readFileSync(file, "utf8"))) } : emptyState();
  }

  update(change: (draft: FeishuState) => void) {
    const draft = structuredClone(this.state);
    change(draft);
    const now = Date.now();
    for (const [nonce, expires] of Object.entries(draft.usedNonces)) if (expires < now) delete draft.usedNonces[nonce];
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const fd = openSync(this.file + ".tmp", "w", 0o600);
    try {
      writeFileSync(fd, this.encode(JSON.stringify(draft)));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(this.file + ".tmp", this.file);
    this.state = draft;
  }
}

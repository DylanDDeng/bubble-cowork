// The bridge's view of Feishu: a small transport over @larksuite/channel so the
// bridge logic can run against a fake in tests.
import { createLarkChannel, registerApp, type LarkChannel, type NormalizedMessage, type CardActionEvent } from "@larksuite/channel";
import type { FeishuDomain } from "./store";

export interface SendTarget {
  chatId: string;
  replyTo?: string;
  replyInThread?: boolean;
}

export interface FeishuTransport {
  botOpenId(): string | undefined;
  sendCard(target: SendTarget, card: object): Promise<{ messageId: string; cardId: string }>;
  updateCard(cardId: string, card: object, sequence: number): Promise<void>;
  sendMarkdown(target: SendTarget, text: string): Promise<string>;
  recall(messageId: string): Promise<void>;
  addReaction(messageId: string, emoji: string): Promise<string | undefined>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
  downloadToFile(messageId: string, fileKey: string, type: "image" | "file", dest: string): Promise<void>;
  /** A quoted message's sender and text, for reply context. */
  fetchMessage(messageId: string): Promise<{ sender?: string; text: string } | undefined>;
  /** Topic id of a message whose event omitted it (first message of a topic). */
  threadIdOf(messageId: string): Promise<string | undefined>;
  /** Earlier messages in a topic, oldest first. */
  topicHistory(threadId: string, limit: number): Promise<{ sender: string; text: string }[]>;
  chatName(chatId: string): Promise<string | undefined>;
}

export const DOMAINS: Record<FeishuDomain, { open: string; accounts: string }> = {
  feishu: { open: "https://open.feishu.cn", accounts: "accounts.feishu.cn" },
  lark: { open: "https://open.larksuite.com", accounts: "accounts.larksuite.com" },
};

export interface ChannelHandlers {
  message: (msg: NormalizedMessage) => void;
  cardAction: (evt: CardActionEvent) => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>;
  state: (state: "connected" | "reconnecting" | "error", detail?: string) => void;
}

function textOf(raw: unknown): string {
  const item = raw as { msg_type?: string; body?: { content?: string } } | undefined;
  try {
    const content = JSON.parse(item?.body?.content ?? "{}") as Record<string, unknown>;
    if (typeof content.text === "string") return content.text;
    if (typeof content.title === "string") return content.title;
  } catch {}
  return item?.msg_type ? `[${item.msg_type}]` : "";
}

/** Connects with the official channel SDK and adapts it to `FeishuTransport`. */
export async function connectChannel(
  credentials: { appId: string; appSecret: string; domain: FeishuDomain },
  handlers: ChannelHandlers,
): Promise<{ transport: FeishuTransport; channel: LarkChannel }> {
  const channel = createLarkChannel({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    domain: DOMAINS[credentials.domain].open,
    source: "aegis",
    includeRawEvent: true,
    resolveChatMode: true,
    resolveSenderNames: true,
    respectProxyEnv: true,
    httpTimeoutMs: 30000,
    handshakeTimeoutMs: 8000,
    keepalive: { enabled: true, onUnrecoverable: () => handlers.state("error", "The connection to Feishu was lost.") },
    // The bridge does its own per-chat batching and must handle card clicks
    // while a run is in flight.
    safety: { chatQueue: { enabled: false } },
    // Access is decided by the bridge (owner, invited users and groups).
    policy: { dmMode: "open", requireMention: false, respondToMentionAll: false },
  });
  channel.on({
    message: (msg) => handlers.message(msg),
    cardAction: (evt) => handlers.cardAction(evt) as never,
    reconnecting: () => handlers.state("reconnecting"),
    reconnected: () => handlers.state("connected"),
    error: (err) => handlers.state("error", err.message),
  });
  await channel.connect();
  const send = (target: SendTarget, input: Parameters<LarkChannel["send"]>[1]) =>
    channel.send(target.chatId, input, { replyTo: target.replyTo, replyInThread: target.replyInThread });
  const transport: FeishuTransport = {
    botOpenId: () => {
      try {
        return channel.getBotIdentity().openId;
      } catch {
        return undefined;
      }
    },
    async sendCard(target, card) {
      const { cardId } = await channel.createCard(card);
      const { messageId } = await send(target, { cardId });
      return { messageId, cardId };
    },
    updateCard: (cardId, card, sequence) => channel.updateCardById(cardId, card, sequence),
    async sendMarkdown(target, text) {
      return (await send(target, { markdown: text })).messageId;
    },
    recall: (messageId) => channel.recallMessage(messageId),
    async addReaction(messageId, emoji) {
      try {
        return await channel.addReaction(messageId, emoji);
      } catch {
        return undefined;
      }
    },
    async removeReaction(messageId, reactionId) {
      await channel.removeReaction(messageId, reactionId).catch(() => {});
    },
    async downloadToFile(messageId, fileKey, type, dest) {
      await channel.downloadResourceToFile(messageId, fileKey, type, dest);
    },
    async fetchMessage(messageId) {
      const msg = await channel.fetchMessage(messageId).catch(() => undefined);
      return msg ? { sender: msg.senderName, text: msg.content } : undefined;
    },
    async threadIdOf(messageId) {
      const raw = (await channel.fetchRawMessage(messageId).catch(() => undefined)) as { thread_id?: string } | undefined;
      return raw?.thread_id || undefined;
    },
    async topicHistory(threadId, limit) {
      try {
        const res = await channel.rawClient.im.v1.message.list({
          params: { container_id_type: "thread", container_id: threadId, page_size: Math.min(limit, 50), sort_type: "ByCreateTimeDesc" },
        });
        const items = (res.data?.items ?? []) as { sender?: { id?: string; sender_type?: string } }[];
        return items
          .reverse()
          .map((item) => ({ sender: item.sender?.sender_type === "app" ? "bot" : item.sender?.id ?? "user", text: textOf(item) }))
          .filter((m) => m.text);
      } catch {
        return [];
      }
    },
    async chatName(chatId) {
      return (await channel.getChatInfo(chatId).catch(() => undefined))?.name;
    },
  };
  return { transport, channel };
}

/**
 * QR app setup: Feishu creates (or updates) a bot app for whoever scans the
 * code and returns its credentials. `onUrl` gets the URL to render as a QR.
 */
export async function registerWithQr(options: {
  domain: FeishuDomain;
  onUrl: (url: string, expiresIn: number) => void;
  signal: AbortSignal;
}) {
  const result = await registerApp({
    domain: DOMAINS.feishu.accounts,
    larkDomain: DOMAINS.lark.accounts,
    source: "aegis",
    signal: options.signal,
    onQRCodeReady: ({ url, expireIn }) => options.onUrl(url, expireIn),
    appPreset: { name: "Aegis", desc: "Run your Aegis agents from Feishu." },
    addons: {
      preset: true,
      // Group messages without @ (topic context) and card entities for progress cards.
      scopes: { tenant: ["im:message.group_msg", "cardkit:card:write"] },
    },
  });
  return {
    appId: result.client_id,
    appSecret: result.client_secret,
    ownerOpenId: result.user_info?.open_id,
    domain: (result.user_info?.tenant_brand === "lark" ? "lark" : "feishu") as FeishuDomain,
  };
}

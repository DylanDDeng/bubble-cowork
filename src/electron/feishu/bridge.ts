// Drives Aegis sessions from Feishu chats. Each chat (or topic) is bound to one
// Aegis session; messages become prompts, each turn renders as a streaming
// progress card with a Stop button, and approvals / questions become cards
// with buttons. Sessions keep their own approval settings: a full-access
// session just runs, anything else asks here.
import { mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import type { CardActionEvent, NormalizedMessage } from "@larksuite/channel";
import type {
  Attachment,
  PermissionRequestPayload,
  PermissionResult,
  ServerEvent,
  SessionStartPayload,
  StreamMessage,
} from "../../shared/types";
import { PERMISSION_OPTIONS, PROVIDERS, PROVIDER_LABELS, permissionLabel, resolveAgent } from "./agent-settings";
import { signButton, verifyButton, type ButtonClaims } from "./callback-token";
import {
  answerOverflow,
  interruptedTurnCard,
  button,
  buttonRow,
  markdown,
  maskEmails,
  promptCard,
  promptKind,
  resolvedPromptCard,
  simpleCard,
  turnCard,
} from "./cards";
import type { FeishuTransport, SendTarget } from "./channel";
import { ScopeQueue, batchPrompt, type QueuedMessage } from "./queue";
import type { Binding, FeishuStore } from "./store";
import { TurnState } from "./turn";

export interface FeishuRuntime {
  projects(): { path: string; name: string }[];
  session(id: string): { id: string; title: string; provider: string; status: string; cwd?: string | null } | undefined;
  recentSessions(cwd: string): { id: string; title: string; provider: string; status: string; updatedAt: number }[];
  start(payload: SessionStartPayload, onCreated: (sessionId: string) => void): Promise<string | null>;
  send(sessionId: string, prompt: string, attachments?: Attachment[]): Promise<boolean>;
  stop(sessionId: string): void;
  respond(sessionId: string, toolUseId: string, result: PermissionResult): boolean;
  attach(name: string, data: Uint8Array): Promise<Attachment>;
  /** The desktop composer's remembered choices (`cowork.preferred*`). */
  desktopPreferences(): Record<string, string>;
  followUp(): "queue" | "steer";
  tmpDir(): string;
}

/** Providers whose running turn accepts a new message (same rule as the desktop composer). */
const STEERABLE = new Set(["codex", "kimi", "deepseek"]);
const DAY = 24 * 3600 * 1000;
const RENDER_MS = 500;
const SHOW_EMPTY_CARD_AFTER_MS = 1200;
const BROAD_DIRS = ["/", "/Users", "/home", "/tmp", "/private/tmp", "/Volumes"];

interface TurnRun {
  scope: string;
  sessionId: string;
  target: SendTarget;
  turn: TurnState;
  fromDesktop: boolean;
  requesters: string[];
  reactions: { messageId: string; reactionId: string }[];
  stopped: boolean;
  cardId?: string;
  messageId?: string;
  seq: number;
  timer?: ReturnType<typeof setTimeout>;
  rendering: Promise<void>;
  stopToken: string;
  /** When the live card was last saved for restart recovery. */
  savedAt?: number;
}

interface PromptRun {
  scope: string;
  request: PermissionRequestPayload;
  title: string;
  cardId?: string;
  seq: number;
}

interface Pending {
  scope: string;
  target: SendTarget;
  requesters: string[];
  reactions: { messageId: string; reactionId: string }[];
}

export class FeishuBridge {
  private transport?: FeishuTransport;
  private queue: ScopeQueue;
  private turns = new Map<string, TurnRun>();
  private prompts = new Map<string, PromptRun>();
  /** Set right before a prompt goes to a session, consumed by its `stream.user_prompt`. */
  private pendingTurn = new Map<string, Pending>();
  private starting = new Set<string>();
  private hinted = new Map<string, number>();
  private batchContext = new Map<string, Pending>();
  /** One-time code shown in Settings so the owner can claim a manually configured bot. */
  claimCode?: string;

  constructor(
    private store: FeishuStore,
    private runtime: FeishuRuntime,
    private log: (message: string) => void = () => {},
  ) {
    this.queue = new ScopeQueue((scope, batch) => void this.runBatch(scope, batch).catch((e) => this.log(`batch failed: ${e}`)));
  }

  attach(transport: FeishuTransport | undefined) {
    this.transport = transport;
    if (transport && !this.recovered) {
      this.recovered = true;
      void this.closeInterruptedCards(transport).catch((e) => this.log(`restart cleanup failed: ${e}`));
    }
  }

  private recovered = false;

  /**
   * Cards still showing a run or an approval when Aegis last quit can't be
   * acted on any more (the run died with the app): mark them ended and say so.
   */
  private async closeInterruptedCards(transport: FeishuTransport) {
    const open = Object.entries(this.store.state.openCards);
    if (!open.length) return;
    this.store.update((s) => {
      s.openCards = {};
    });
    // Larger than any per-card counter used before the restart.
    const sequence = Math.floor(Date.now() / 1000) - 1_700_000_000;
    const told = new Set<string>();
    for (const [cardId, card] of open) {
      if (card.kind === "prompt") {
        await transport
          .updateCard(cardId, resolvedPromptCard(card.title ?? "Approval", "Aegis restarted, so this request ended. Send your message again to retry."), sequence)
          .catch(() => {});
        continue;
      }
      if (card.card) await transport.updateCard(cardId, interruptedTurnCard(card.card), sequence).catch(() => {});
      for (const r of card.reactions ?? []) await transport.removeReaction(r.messageId, r.reactionId);
      const where = `${card.target.chatId}:${card.target.replyInThread ? card.target.replyTo : ""}`;
      if (told.has(where)) continue;
      told.add(where);
      await transport
        .sendMarkdown(card.target, "Aegis restarted, so the last run here was interrupted. Send a message to continue.")
        .catch(() => {});
    }
  }

  private saveOpenCard(cardId: string, card: FeishuStore["state"]["openCards"][string] | undefined) {
    this.store.update((s) => {
      if (card) s.openCards[cardId] = card;
      else delete s.openCards[cardId];
    });
  }

  close() {
    this.queue.close();
    for (const run of this.turns.values()) clearTimeout(run.timer);
  }

  bindings() {
    return this.store.state.bindings;
  }

  isBound(sessionId: string) {
    return Object.values(this.store.state.bindings).some((b) => b.sessionId === sessionId);
  }

  unbind(scope: string) {
    this.store.update((s) => {
      delete s.bindings[scope];
    });
  }

  // ── Inbound messages ────────────────────────────────────────────────────

  async handleMessage(msg: NormalizedMessage): Promise<void> {
    const transport = this.transport;
    if (!transport || msg.senderIsBot) return;
    const state = this.store.state;
    const isOwner = !!state.ownerOpenId && msg.senderId === state.ownerOpenId;
    const group = msg.chatType === "group";
    const topic = msg.chatMode === "topic";
    let threadId = topic ? msg.threadId : undefined;
    if (topic && !threadId) threadId = (await transport.threadIdOf(msg.messageId)) || msg.rootId || msg.messageId;
    const scope = threadId ? `${msg.chatId}:${threadId}` : msg.chatId;
    const bound = !!state.bindings[scope];
    // Groups need an @mention, except follow-ups inside a topic this bot is already working in.
    if (group && !msg.mentionedBot && !(topic && bound)) return;
    const allowed = isOwner || (group ? state.allowedChats.some((c) => c.chatId === msg.chatId) : state.allowedUsers.some((u) => u.openId === msg.senderId));
    const target: SendTarget = { chatId: msg.chatId, replyTo: msg.messageId, replyInThread: topic || undefined };
    const text = msg.content
      .replace(/!\[image\]\([^)]*\)/g, "")
      .replace(/<file key="[^"]*"( name="[^"]*")?\s*\/>/g, "")
      .trim();
    if (!state.ownerOpenId && this.claimCode && msg.chatType === "p2p" && text === `/claim ${this.claimCode}`) {
      this.claimCode = undefined;
      this.store.update((s) => {
        s.ownerOpenId = msg.senderId;
      });
      await this.say(target, "You're set as the owner of this Aegis bot. Send a message to start a task.");
      return;
    }
    if (!allowed) {
      // Strangers get nothing; an @ in a group that isn't connected gets one hint an hour.
      if (group && Date.now() - (this.hinted.get(msg.chatId) ?? 0) > 3600_000) {
        this.hinted.set(msg.chatId, Date.now());
        await this.say(target, "This chat isn't connected to Aegis yet. The Aegis owner can send `/invite group` here.");
      }
      return;
    }
    if (text.startsWith("/") && (await this.command(scope, msg, text, target, isOwner))) return;

    const attachments: Attachment[] = [];
    const notes: string[] = [];
    for (const resource of msg.resources) {
      if (resource.type !== "image" && resource.type !== "file") {
        notes.push(`[Skipped a ${resource.type}: not supported]`);
        continue;
      }
      const name = resource.fileName || (resource.type === "image" ? `image-${resource.fileKey.slice(-8)}.png` : resource.fileKey);
      const dir = join(this.runtime.tmpDir(), msg.messageId);
      const dest = join(dir, name.replace(/[/\\]/g, "_"));
      try {
        mkdirSync(dir, { recursive: true });
        await transport.downloadToFile(msg.messageId, resource.fileKey, resource.type, dest);
        attachments.push(await this.runtime.attach(name, readFileSync(dest)));
      } catch (error) {
        notes.push(`[Skipped ${name}: ${error instanceof Error ? error.message : "could not attach"}]`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    const context: string[] = [];
    if (msg.replyToMessageId) {
      const quoted = await transport.fetchMessage(msg.replyToMessageId);
      if (quoted?.text) context.push(`Replying to ${quoted.sender || "a message"}:\n> ${quoted.text.slice(0, 2000).replace(/\n/g, "\n> ")}`);
    }
    if (topic && threadId && !bound) {
      const history = (await transport.topicHistory(threadId, 40)).filter((m) => m.text && !m.text.startsWith("/"));
      // The last item is this message itself.
      const earlier = history.slice(0, -1);
      if (earlier.length) context.push("Earlier in this topic:\n" + earlier.map((m) => `[${m.sender}]: ${m.text.slice(0, 1000)}`).join("\n"));
    }
    const body = [...context, text, ...notes].filter(Boolean).join("\n\n");
    if (!body && !attachments.length) return;
    const reactionId = await transport.addReaction(msg.messageId, "Typing");
    const item: QueuedMessage = { messageId: msg.messageId, senderId: msg.senderId, senderName: msg.senderName, text: body, attachments };
    const context0 = this.batchContext.get(scope) ?? { scope, target, requesters: [], reactions: [] };
    context0.target = target;
    if (!context0.requesters.includes(msg.senderId)) context0.requesters.push(msg.senderId);
    if (reactionId) context0.reactions.push({ messageId: msg.messageId, reactionId });
    this.batchContext.set(scope, context0);

    const binding = state.bindings[scope];
    const session = binding && this.runtime.session(binding.sessionId);
    const running = session && ["running", "stopping"].includes(session.status);
    if (running && this.runtime.followUp() === "steer" && STEERABLE.has(session.provider)) {
      this.batchContext.delete(scope);
      const ok = await this.runtime.send(session.id, batchPrompt([item]), attachments);
      if (ok) {
        const run = this.turns.get(session.id);
        if (run) {
          run.reactions.push(...context0.reactions);
          for (const r of context0.requesters) if (!run.requesters.includes(r)) run.requesters.push(r);
        }
        return;
      }
      this.batchContext.set(scope, context0);
    }
    if (running) this.queue.block(scope);
    this.queue.push(scope, item);
  }

  private async runBatch(scope: string, batch: QueuedMessage[]) {
    const pending = this.batchContext.get(scope) ?? { scope, target: { chatId: scope.split(":")[0] }, requesters: [], reactions: [] };
    this.batchContext.delete(scope);
    const prompt = batchPrompt(batch);
    const attachments = batch.flatMap((m) => m.attachments as Attachment[]);
    this.queue.block(scope);
    const binding = this.store.state.bindings[scope];
    const session = binding && this.runtime.session(binding.sessionId);
    if (session) {
      this.pendingTurn.set(session.id, pending);
      const ok = await this.runtime.send(session.id, prompt, attachments.length ? attachments : undefined);
      if (ok) return;
      this.pendingTurn.delete(session.id);
      const fresh = this.runtime.session(session.id);
      if (fresh && ["running", "stopping"].includes(fresh.status)) {
        // Busy (e.g. a delegated run): keep the binding and send once it's free.
        this.batchContext.set(scope, pending);
        for (const m of batch) this.queue.push(scope, m);
        return;
      }
      this.queue.unblock(scope);
      await this.clearReactions(pending.reactions);
      await this.say(pending.target, "Couldn't send that to the session. Check Aegis on your Mac, or send `/new` to start over.");
      return;
    }
    if (binding) this.unbind(scope);
    await this.startSession(scope, prompt, attachments, pending);
  }

  private async startSession(scope: string, prompt: string, attachments: Attachment[], pending: Pending) {
    const prefs = this.store.state.prefs[scope] ?? {};
    const cwd = prefs.cwd || this.store.state.defaultCwd;
    if (!cwd) {
      this.queue.unblock(scope);
      await this.clearReactions(pending.reactions);
      await this.say(pending.target, "Choose a project first: send `/project`.");
      return;
    }
    if (this.starting.has(scope)) return;
    this.starting.add(scope);
    const agent = resolveAgent(prefs, this.runtime.desktopPreferences());
    let created: string | undefined;
    try {
      const id = await this.runtime.start(
        {
          ...agent.payload,
          prompt,
          cwd,
          projectCwd: cwd,
          scope: "project",
          envMode: "local",
          title: prompt.split("\n")[0].slice(0, 60) || "Feishu task",
          attachments: attachments.length ? attachments : undefined,
        } as SessionStartPayload,
        (sessionId) => {
          created = sessionId;
          this.pendingTurn.set(sessionId, pending);
          this.bind(scope, sessionId, pending.target);
        },
      );
      if (!id && !created) {
        this.queue.unblock(scope);
        await this.clearReactions(pending.reactions);
        await this.say(pending.target, "Couldn't start a task. Check that the agent is set up in Aegis on your Mac.");
      }
    } finally {
      this.starting.delete(scope);
    }
  }

  private bind(scope: string, sessionId: string, target: SendTarget) {
    const [chatId, threadId] = scope.split(":");
    this.store.update((s) => {
      for (const [key, b] of Object.entries(s.bindings)) if (b.sessionId === sessionId && key !== scope) delete s.bindings[key];
      s.bindings[scope] = {
        sessionId,
        chatId,
        ...(threadId ? { threadId, anchorMessageId: s.bindings[scope]?.anchorMessageId ?? target.replyTo } : {}),
        updatedAt: Date.now(),
      };
    });
  }

  private scopeOf(sessionId: string): [string, Binding] | undefined {
    return Object.entries(this.store.state.bindings).find(([, b]) => b.sessionId === sessionId);
  }

  // ── Session events (from the app's broadcast) ───────────────────────────

  capture(event: ServerEvent) {
    if (!this.transport) return;
    const payload = event.payload as { sessionId?: string } & Record<string, unknown>;
    const sessionId = payload?.sessionId;
    if (!sessionId) return;
    switch (event.type) {
      case "stream.user_prompt": {
        const bound = this.scopeOf(sessionId);
        if (!bound) return;
        const previous = this.turns.get(sessionId);
        if (previous) this.finish(previous, previous.stopped ? "stopped" : "done");
        const pending = this.pendingTurn.get(sessionId);
        this.pendingTurn.delete(sessionId);
        const [scope, binding] = bound;
        this.queue.block(scope);
        const target: SendTarget = pending?.target ?? {
          chatId: binding.chatId,
          replyTo: binding.anchorMessageId,
          replyInThread: binding.threadId ? true : undefined,
        };
        const run: TurnRun = {
          scope,
          sessionId,
          target,
          turn: new TurnState(),
          fromDesktop: !pending,
          requesters: pending?.requesters ?? [],
          reactions: pending?.reactions ?? [],
          stopped: false,
          seq: 0,
          rendering: Promise.resolve(),
          stopToken: "",
        };
        run.stopToken = this.token("stop", target.chatId, run.requesters, DAY, { s: sessionId });
        this.turns.set(sessionId, run);
        run.timer = setTimeout(() => this.render(run), SHOW_EMPTY_CARD_AFTER_MS);
        return;
      }
      case "stream.message": {
        const run = this.turns.get(sessionId);
        if (run && run.turn.ingest(payload.message as StreamMessage)) this.schedule(run);
        return;
      }
      case "runner.error": {
        const run = this.turns.get(sessionId);
        if (run && typeof payload.message === "string") run.turn.error = payload.message;
        return;
      }
      case "permission.request":
        void this.postPrompt(event.payload as PermissionRequestPayload);
        return;
      case "permission.dismissed": {
        const key = `${sessionId}:${(payload as { toolUseId?: string }).toolUseId}`;
        const prompt = this.prompts.get(key);
        if (prompt) void this.closePrompt(key, "Handled in Aegis on your Mac.");
        return;
      }
      case "session.status": {
        const status = payload.status as string;
        if (["running", "stopping"].includes(status)) return;
        const run = this.turns.get(sessionId);
        if (run) this.finish(run, run.stopped ? "stopped" : status === "error" ? "failed" : "done");
        const bound = this.scopeOf(sessionId);
        if (bound) this.queue.unblock(bound[0]);
        // Questions left open when the turn ended can't be answered any more.
        for (const [key, prompt] of this.prompts) if (prompt.request.sessionId === sessionId) void this.closePrompt(key, "This request ended.");
        return;
      }
      case "session.deleted": {
        const bound = this.scopeOf(sessionId);
        if (bound) this.unbind(bound[0]);
        return;
      }
    }
  }

  private schedule(run: TurnRun) {
    if (!run.cardId && run.turn.hasContent()) {
      // First visible content: show the card now instead of after the empty-card delay.
      clearTimeout(run.timer);
      run.timer = undefined;
    }
    if (run.timer) return;
    run.timer = setTimeout(() => this.render(run), run.cardId ? RENDER_MS : run.turn.hasContent() ? 0 : SHOW_EMPTY_CARD_AFTER_MS);
  }

  private render(run: TurnRun): Promise<void> {
    run.timer = undefined;
    run.rendering = run.rendering.then(async () => {
      const transport = this.transport;
      if (!transport) return;
      const card = turnCard(run.turn, { stopToken: run.turn.status === "running" ? run.stopToken : undefined, fromDesktop: run.fromDesktop });
      try {
        if (!run.cardId) {
          const sent = await transport.sendCard(run.target, card);
          run.cardId = sent.cardId;
          run.messageId = sent.messageId;
          run.seq = 1;
        } else {
          await transport.updateCard(run.cardId, card, ++run.seq);
        }
        // Saved every few seconds while running, so a restart can close it with what it showed.
        if (run.turn.status === "running" && (!run.savedAt || Date.now() - run.savedAt > 4000)) {
          run.savedAt = Date.now();
          this.saveOpenCard(run.cardId, { kind: "turn", target: run.target, card, reactions: run.reactions });
        }
      } catch (error) {
        this.log(`card update failed: ${error instanceof Error ? error.message : error}`);
      }
    });
    return run.rendering;
  }

  private finish(run: TurnRun, status: "done" | "stopped" | "failed") {
    if (this.turns.get(run.sessionId) === run) this.turns.delete(run.sessionId);
    clearTimeout(run.timer);
    run.timer = undefined;
    run.turn.finish(status, status === "failed" ? run.turn.error : undefined);
    const transport = this.transport;
    void (async () => {
      if (!run.cardId && !run.turn.hasContent() && status === "done") {
        await run.rendering;
      } else {
        await this.render(run);
      }
      if (run.cardId && run.cardId in this.store.state.openCards) this.saveOpenCard(run.cardId, undefined);
      if (transport && run.messageId && !run.turn.hasContent() && status === "done") await transport.recall(run.messageId).catch(() => {});
      const overflow = answerOverflow(run.turn);
      if (transport && overflow) await transport.sendMarkdown(run.target, maskEmails(overflow)).catch(() => {});
      await this.clearReactions(run.reactions);
    })();
  }

  private async clearReactions(reactions: { messageId: string; reactionId: string }[]) {
    if (!this.transport) return;
    await Promise.all(reactions.map((r) => this.transport!.removeReaction(r.messageId, r.reactionId)));
  }

  // ── Approvals and questions ─────────────────────────────────────────────

  private async postPrompt(request: PermissionRequestPayload) {
    const bound = this.scopeOf(request.sessionId);
    const transport = this.transport;
    if (!bound || !transport) return;
    const [scope, binding] = bound;
    const run = this.turns.get(request.sessionId);
    const target: SendTarget = run?.target ?? {
      chatId: binding.chatId,
      replyTo: binding.anchorMessageId,
      replyInThread: binding.threadId ? true : undefined,
    };
    const requesters = run?.requesters ?? [];
    const key = `${request.sessionId}:${request.toolUseId}`;
    const card = promptCard(request, {
      token: (action) => this.token("perm", target.chatId, requesters, DAY, { s: request.sessionId, u: request.toolUseId, x: action }),
      plan: run?.turn.plan,
    });
    const title = (card as { header?: { title?: { content?: string } } }).header?.title?.content ?? "Approval";
    const prompt: PromptRun = { scope, request, title, seq: 1 };
    this.prompts.set(key, prompt);
    try {
      const sent = await transport.sendCard(target, card);
      prompt.cardId = sent.cardId;
      if (this.prompts.get(key) === prompt) this.saveOpenCard(sent.cardId, { kind: "prompt", target, title });
    } catch (error) {
      this.log(`approval card failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  private async closePrompt(key: string, outcome: string) {
    const prompt = this.prompts.get(key);
    if (!prompt) return;
    this.prompts.delete(key);
    if (prompt.cardId) this.saveOpenCard(prompt.cardId, undefined);
    if (prompt.cardId && this.transport)
      await this.transport.updateCard(prompt.cardId, resolvedPromptCard(prompt.title, outcome), ++prompt.seq).catch(() => {});
  }

  private answerPrompt(claims: ButtonClaims, evt: CardActionEvent): Record<string, unknown> {
    const sessionId = String(claims.d?.s ?? "");
    const toolUseId = String(claims.d?.u ?? "");
    const action = String(claims.d?.x ?? "");
    const key = `${sessionId}:${toolUseId}`;
    const prompt = this.prompts.get(key);
    if (!prompt) return toast("info", "This request was already handled.");
    const request = prompt.request;
    const input = request.input as unknown as Record<string, unknown>;
    const who = evt.operator.name || "you";
    let result: PermissionResult;
    let outcome: string;
    const kind = promptKind(request);
    if (action === "deny" || action === "desktop") {
      result = { behavior: "deny", message: "Declined in Feishu." };
      outcome = `Denied by ${who}.`;
    } else if (kind === "tool") {
      // No updatedInput: the runner keeps the tool's real input (the card fields are display only).
      result = { behavior: "allow", scope: action === "session" ? "session" : "once" };
      outcome = action === "session" ? `Allowed for this session by ${who}.` : `Allowed once by ${who}.`;
    } else if (kind === "acp" && action.startsWith("acp:")) {
      const optionId = action.slice(4);
      const option = (input.options as { optionId: string; name: string; kind?: string }[]).find((o) => o.optionId === optionId);
      if (!option) return toast("error", "That option is no longer available.");
      const reject = `${option.kind ?? ""} ${option.optionId}`.toLowerCase().includes("reject");
      result = { behavior: reject ? "deny" : "allow", scope: option.kind === "allow_always" ? "session" : "once", updatedInput: { optionId } };
      outcome = `${option.name} — ${who}.`;
    } else if (kind === "question") {
      const questions = input.questions as { question: string; multiSelect?: boolean; options: { label: string }[] }[];
      const answers: Record<string, string> = {};
      if (action.startsWith("q:")) {
        const option = questions[0]?.options[Number(action.slice(2))];
        if (!option) return toast("error", "That option is no longer available.");
        answers[questions[0].question] = option.label;
      } else {
        const form = evt.action.formValue ?? {};
        for (const [i, q] of questions.entries()) {
          const value = form[`q${i}`];
          const picked = Array.isArray(value) ? value.map(String) : typeof value === "string" ? [value] : [];
          if (!picked.length) return { ...toast("warning", `Answer “${q.question}” first.`), retry: true };
          answers[q.question] = picked.join(",");
        }
      }
      result = { behavior: "allow", updatedInput: { ...input, answers } };
      outcome = Object.entries(answers).map(([q, a]) => `**${q}** ${a}`).join("\n") + `\n— ${who}`;
    } else {
      return toast("info", "Answer this one in Aegis on your Mac.");
    }
    if (!this.runtime.respond(sessionId, toolUseId, result)) {
      void this.closePrompt(key, "This request was already handled.");
      return toast("info", "This request was already handled.");
    }
    this.prompts.delete(key);
    if (prompt.cardId) this.saveOpenCard(prompt.cardId, undefined);
    return { toast: { type: "success", content: "Sent" }, card: { type: "raw", data: resolvedPromptCard(prompt.title, outcome) } };
  }

  // ── Card buttons ────────────────────────────────────────────────────────

  private token(action: string, chatId: string, operators: string[], ttl: number, data: Record<string, unknown>) {
    return signButton(this.store.state.callbackKey, { a: action, c: chatId, o: operators, exp: Date.now() + ttl, d: data });
  }

  handleCardAction(evt: CardActionEvent): Record<string, unknown> {
    const value = evt.action.value as { t?: unknown } | undefined;
    const claims = verifyButton(
      this.store.state.callbackKey,
      value?.t,
      { chatId: evt.chatId, operator: evt.operator.openId, owner: this.store.state.ownerOpenId },
      (nonce) => nonce in this.store.state.usedNonces,
    );
    if (typeof claims === "string") {
      const messages: Record<string, string> = {
        "not-allowed": "Only the person who started this can do that.",
        expired: "This button has expired.",
        replayed: "Already done.",
      };
      return toast("error", messages[claims] ?? "This button isn't valid.");
    }
    // Spent on every outcome except a form that still needs answers.
    const response = this.dispatchAction(claims, evt);
    if (!response.retry) {
      this.store.update((s) => {
        s.usedNonces[claims.n!] = claims.exp;
      });
    }
    delete response.retry;
    return response;
  }

  private dispatchAction(claims: ButtonClaims, evt: CardActionEvent): Record<string, unknown> {
    const scope = typeof claims.d?.scope === "string" ? claims.d.scope : evt.chatId;
    switch (claims.a) {
      case "stop": {
        const sessionId = String(claims.d?.s ?? "");
        const run = this.turns.get(sessionId);
        if (!run) return toast("info", "Nothing is running.");
        run.stopped = true;
        this.queue.cancel(run.scope);
        this.runtime.stop(sessionId);
        return toast("success", "Stopping…");
      }
      case "perm":
        return this.answerPrompt(claims, evt);
      case "project": {
        const path = String(claims.d?.path ?? "");
        this.store.update((s) => {
          s.prefs[scope] = { ...s.prefs[scope], cwd: path };
          delete s.bindings[scope];
        });
        return { toast: { type: "success", content: "Project changed" }, card: { type: "raw", data: this.projectCard(scope, evt.operator.openId, evt.chatId) } };
      }
      case "agent": {
        const field = String(claims.d?.f ?? "");
        const val = String(claims.d?.v ?? "");
        this.store.update((s) => {
          const prefs = { ...s.prefs[scope] };
          if (field === "provider") {
            prefs.provider = val;
            delete prefs.model;
            delete prefs.permissionMode;
          } else if (field === "permission") prefs.permissionMode = val;
          else if (field === "reset") {
            delete prefs.provider;
            delete prefs.model;
            delete prefs.permissionMode;
          }
          s.prefs[scope] = prefs;
          delete s.bindings[scope];
        });
        return { toast: { type: "success", content: "Saved. Your next message starts a new task." }, card: { type: "raw", data: this.agentCard(scope, evt.operator.openId, evt.chatId) } };
      }
      case "bind": {
        const sessionId = String(claims.d?.s ?? "");
        if (!this.runtime.session(sessionId)) return toast("error", "That task no longer exists.");
        this.bind(scope, sessionId, { chatId: evt.chatId });
        return { toast: { type: "success", content: "Continuing that task here" }, card: { type: "raw", data: simpleCard("Continuing here", [markdown(`Messages here now go to **${this.runtime.session(sessionId)?.title ?? "the task"}**.`)]) } };
      }
    }
    return toast("error", "Unknown action.");
  }

  // ── Commands ────────────────────────────────────────────────────────────

  /** Returns false for unknown commands so they reach the agent (e.g. its own slash commands). */
  private async command(scope: string, msg: NormalizedMessage, text: string, target: SendTarget, isOwner: boolean): Promise<boolean> {
    const [name, ...args] = text.split(/\s+/);
    const state = this.store.state;
    const binding = state.bindings[scope];
    const session = binding && this.runtime.session(binding.sessionId);
    switch (name.toLowerCase()) {
      case "/help":
        await this.card(target, simpleCard("Aegis in Feishu", [
          markdown(
            [
              "Send a message to start a task on your Mac. Messages here continue the same task.",
              "",
              "`/new` start a new task",
              "`/stop` stop the current run",
              "`/status` what this chat is connected to",
              "`/project` choose the project",
              "`/agent` choose the agent and permissions",
              "`/sessions` continue a task from Aegis here",
              ...(isOwner ? ["`/invite @someone` or `/invite group` give access", "`/remove @someone` or `/remove group` take it away"] : []),
            ].join("\n"),
          ),
        ]));
        return true;
      case "/new": {
        this.queue.cancel(scope);
        this.unbind(scope);
        await this.say(target, "Your next message starts a new task.");
        return true;
      }
      case "/stop": {
        const dropped = this.queue.cancel(scope).length;
        const run = session && this.turns.get(session.id);
        if (session && ["running", "stopping"].includes(session.status)) {
          if (run) run.stopped = true;
          this.runtime.stop(session.id);
          await this.say(target, dropped ? `Stopping. ${dropped} queued ${dropped === 1 ? "message was" : "messages were"} dropped.` : "Stopping.");
        } else await this.say(target, "Nothing is running.");
        return true;
      }
      case "/status": {
        const agent = resolveAgent(state.prefs[scope] ?? {}, this.runtime.desktopPreferences());
        const cwd = state.prefs[scope]?.cwd || state.defaultCwd;
        const lines = [
          session ? `**Task:** ${session.title} · ${session.status}` : "**Task:** none yet — your next message starts one",
          `**Agent:** ${PROVIDER_LABELS[agent.provider] ?? agent.provider}${agent.model ? ` · ${agent.model}` : ""} · ${permissionLabel(agent.provider, agent.permissionMode)}`,
          `**Project:** ${cwd ? `\`${cwd}\`` : "not set — send `/project`"}`,
        ];
        if (session) lines.push("_A running task keeps the agent and permissions it started with._");
        await this.card(target, simpleCard("Status", [markdown(lines.join("\n"))]));
        return true;
      }
      case "/project":
        await this.card(target, this.projectCard(scope, msg.senderId, msg.chatId));
        return true;
      case "/agent":
        await this.card(target, this.agentCard(scope, msg.senderId, msg.chatId));
        return true;
      case "/sessions": {
        const cwd = state.prefs[scope]?.cwd || state.defaultCwd;
        const list = cwd ? this.runtime.recentSessions(cwd).slice(0, 8) : [];
        if (!list.length) {
          await this.say(target, cwd ? "No tasks in this project yet." : "Choose a project first: send `/project`.");
          return true;
        }
        const elements = list.flatMap((s) => [
          markdown(`**${s.title}** · ${PROVIDER_LABELS[s.provider] ?? s.provider} · ${s.status}`),
          button(s.id === session?.id ? "Connected here" : "Continue here", this.token("bind", msg.chatId, [msg.senderId], DAY, { s: s.id, scope })),
        ]);
        await this.card(target, simpleCard("Recent tasks", elements));
        return true;
      }
      case "/invite":
      case "/remove": {
        if (!isOwner) {
          await this.say(target, "Only the Aegis owner can change who has access.");
          return true;
        }
        const add = name.toLowerCase() === "/invite";
        const people = msg.mentions.filter((m) => m.openId && !m.isBot && m.openId !== this.transport?.botOpenId());
        if (args.includes("group") && msg.chatType === "group") {
          const chatName = await this.transport?.chatName(msg.chatId);
          this.store.update((s) => {
            s.allowedChats = s.allowedChats.filter((c) => c.chatId !== msg.chatId);
            if (add) s.allowedChats.push({ chatId: msg.chatId, name: chatName });
          });
          await this.say(target, add ? "Everyone in this group can now use Aegis here (with @Aegis)." : "This group no longer has access.");
        } else if (people.length) {
          this.store.update((s) => {
            s.allowedUsers = s.allowedUsers.filter((u) => !people.some((p) => p.openId === u.openId));
            if (add) s.allowedUsers.push(...people.map((p) => ({ openId: p.openId!, name: p.name })));
          });
          const names = people.map((p) => p.name || "them").join(", ");
          await this.say(target, add ? `${names} can now message Aegis directly.` : `${names} no longer ${people.length === 1 ? "has" : "have"} access.`);
        } else {
          await this.say(target, add ? "Mention someone (`/invite @name`) or send `/invite group` in a group." : "Mention someone (`/remove @name`) or send `/remove group` in a group.");
        }
        return true;
      }
    }
    return false;
  }

  private projectCard(scope: string, operator: string, chatId: string) {
    const current = this.store.state.prefs[scope]?.cwd || this.store.state.defaultCwd;
    const projects = this.runtime.projects().filter((p) => !BROAD_DIRS.includes(p.path)).slice(0, 20);
    if (!projects.length) return simpleCard("Projects", [markdown("Open a project in Aegis on your Mac first.")]);
    return simpleCard("Choose a project", [
      markdown(current ? `Current: \`${current}\`` : "No project chosen yet.", true),
      ...projects.map((p) =>
        button(p.path === current ? `✓ ${p.name}` : p.name, this.token("project", chatId, [operator], DAY, { path: p.path, scope }), p.path === current ? "primary" : "default"),
      ),
      markdown("Changing the project starts a new task.", true),
    ]);
  }

  private agentCard(scope: string, operator: string, chatId: string) {
    const prefs = this.store.state.prefs[scope] ?? {};
    const agent = resolveAgent(prefs, this.runtime.desktopPreferences());
    const t = (field: string, value: string) => this.token("agent", chatId, [operator], DAY, { f: field, v: value, scope });
    const modes = (PERMISSION_OPTIONS[agent.provider] ?? []).filter((o) => !o.hidden);
    return simpleCard("Agent for this chat", [
      markdown(`**${PROVIDER_LABELS[agent.provider]}**${agent.model ? ` · ${agent.model}` : ""} · ${permissionLabel(agent.provider, agent.permissionMode)}${prefs.provider || prefs.permissionMode ? "" : " _(Aegis defaults)_"}`),
      markdown("Agent", true),
      buttonRow(PROVIDERS.map((p) => button(PROVIDER_LABELS[p], t("provider", p), p === agent.provider ? "primary" : "default"))),
      ...(modes.length
        ? [markdown("Permissions", true), buttonRow(modes.map((o) => button(o.label, t("permission", o.mode), o.mode === agent.permissionMode ? "primary" : o.tone ? "danger" : "default")))]
        : []),
      buttonRow([button("Use Aegis defaults", t("reset", ""))]),
      markdown("The model follows the agent's default in Aegis. Changes apply to the next new task.", true),
    ]);
  }

  private async card(target: SendTarget, card: object) {
    try {
      await this.transport?.sendCard(target, card);
    } catch (error) {
      this.log(`card failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  private async say(target: SendTarget, text: string) {
    try {
      await this.transport?.sendMarkdown(target, maskEmails(text));
    } catch (error) {
      this.log(`send failed: ${error instanceof Error ? error.message : error}`);
    }
  }
}

const toast = (type: "success" | "info" | "error" | "warning", content: string) => ({ toast: { type, content } });

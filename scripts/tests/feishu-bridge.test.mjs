// Feishu bridge: access, scopes, batching, progress cards, approvals, commands
// and button tokens, against a fake Feishu transport and a fake Aegis runtime.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { FeishuBridge } = require("../../dist-electron/electron/feishu/bridge.js");
const { FeishuStore } = require("../../dist-electron/electron/feishu/store.js");
const { signButton, verifyButton } = require("../../dist-electron/electron/feishu/callback-token.js");
const { turnCard, maskEmails, CARD_ANSWER_LIMIT, answerOverflow } = require("../../dist-electron/electron/feishu/cards.js");
const { TurnState, summarizePatch } = require("../../dist-electron/electron/feishu/turn.js");
const { resolveAgent } = require("../../dist-electron/electron/feishu/agent-settings.js");
const { batchPrompt } = require("../../dist-electron/electron/feishu/queue.js");

const dir = mkdtempSync(join(tmpdir(), "aegis-feishu-test-"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const OWNER = "ou_owner";
const STRANGER = "ou_stranger";
const FRIEND = "ou_friend";
const json = (v) => JSON.stringify(v);

function fakeTransport() {
  const calls = { cards: [], updates: [], markdown: [], reactions: [], removed: [], recalled: [] };
  let n = 0;
  return {
    calls,
    botOpenId: () => "ou_bot",
    async sendCard(target, card) {
      const id = ++n;
      calls.cards.push({ target, card, cardId: `card${id}`, messageId: `om_card${id}` });
      return { messageId: `om_card${id}`, cardId: `card${id}` };
    },
    async updateCard(cardId, card, seq) {
      calls.updates.push({ cardId, card, seq });
    },
    async sendMarkdown(target, text) {
      calls.markdown.push({ target, text });
      return `om_md${++n}`;
    },
    async recall(id) {
      calls.recalled.push(id);
    },
    async addReaction(messageId, emoji) {
      calls.reactions.push({ messageId, emoji });
      return `r_${messageId}`;
    },
    async removeReaction(messageId, reactionId) {
      calls.removed.push({ messageId, reactionId });
    },
    async downloadToFile() {},
    async fetchMessage() {
      return { sender: "Ann", text: "the quoted text" };
    },
    async threadIdOf() {
      return undefined;
    },
    async topicHistory() {
      return [];
    },
    async chatName() {
      return "Team";
    },
  };
}

function fakeRuntime() {
  const sessions = new Map();
  let id = 0;
  const log = { starts: [], sends: [], stops: [], responses: [] };
  return {
    log,
    sessions,
    sendResult: true,
    projects: () => [{ path: "/work/app", name: "app" }],
    session: (sid) => sessions.get(sid),
    recentSessions: () => [...sessions.values()].map((s) => ({ ...s, updatedAt: 1 })),
    async start(payload, onCreated) {
      const sid = `s${++id}`;
      sessions.set(sid, { id: sid, title: payload.title, provider: payload.provider, status: "running", cwd: payload.cwd });
      log.starts.push(payload);
      onCreated(sid);
      return sid;
    },
    async send(sid, prompt) {
      log.sends.push({ sid, prompt });
      return this.sendResult;
    },
    stop(sid) {
      log.stops.push(sid);
    },
    respond(sid, toolUseId, result) {
      log.responses.push({ sid, toolUseId, result });
      return true;
    },
    async attach(name, data) {
      return { id: name, name, path: `/a/${name}`, size: data.length, mimeType: "image/png", kind: "image" };
    },
    desktopPreferences: () => ({
      "cowork.preferredProvider": "claude",
      "cowork.preferredClaudeModel": "claude-x",
      "cowork.preferredClaudePermissionMode": "acceptEdits",
      "cowork.preferredClaudeReasoningEfforts": json({ "claude-x": "high" }),
      "cowork.preferredKimiPermissionMode": "yolo",
    }),
    followUp: () => "queue",
    tmpDir: () => join(dir, "tmp"),
  };
}

function setup(file = "state") {
  const store = new FeishuStore(join(dir, file), (x) => x, (x) => x);
  store.update((s) => {
    s.ownerOpenId = OWNER;
    s.defaultCwd = "/work/app";
    s.enabled = true;
  });
  const runtime = fakeRuntime();
  const transport = fakeTransport();
  const bridge = new FeishuBridge(store, runtime);
  bridge.attach(transport);
  return { store, runtime, transport, bridge };
}

let mid = 0;
const message = (over = {}) => ({
  messageId: `om_${++mid}`,
  chatId: "oc_dm",
  chatType: "p2p",
  chatMode: "p2p",
  senderId: OWNER,
  senderName: "Owner",
  senderIsBot: false,
  content: "hello",
  rawContentType: "text",
  resources: [],
  mentions: [],
  mentionAll: false,
  mentionedBot: false,
  createTime: Date.now(),
  ...over,
});
const tokensOf = (card) => [...json(card).matchAll(/"t":"(fsb1\.[^"]+)"/g)].map((m) => m[1]);
const click = (bridge, card, labelOrIndex, operator = OWNER, chatId = "oc_dm", formValue) => {
  const tokens = tokensOf(card);
  const token = typeof labelOrIndex === "number" ? tokens[labelOrIndex] : tokens.find((t) => {
    const payload = JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString());
    return payload.d?.x === labelOrIndex || payload.a === labelOrIndex;
  });
  assert(token, `no button ${labelOrIndex}`);
  return bridge.handleCardAction({ messageId: "om_x", chatId, operator: { openId: operator, name: "Owner" }, action: { value: { t: token }, tag: "button", formValue } });
};

try {
  // ── Button tokens ────────────────────────────────────────────────────
  {
    const key = "k".repeat(64);
    const spent = new Set();
    const token = signButton(key, { a: "stop", c: "oc_1", o: [FRIEND], exp: Date.now() + 1000 });
    const ok = verifyButton(key, token, { chatId: "oc_1", operator: FRIEND }, (n) => spent.has(n));
    assert.equal(ok.a, "stop");
    assert.equal(verifyButton("x".repeat(64), token, { chatId: "oc_1", operator: FRIEND }, () => false), "bad-signature");
    assert.equal(verifyButton(key, token, { chatId: "oc_2", operator: FRIEND }, () => false), "wrong-chat");
    assert.equal(verifyButton(key, token, { chatId: "oc_1", operator: STRANGER }, () => false), "not-allowed");
    assert.equal(verifyButton(key, token, { chatId: "oc_1", operator: OWNER, owner: OWNER }, () => false).a, "stop", "the owner may always press");
    assert.equal(verifyButton(key, token, { chatId: "oc_1", operator: FRIEND }, () => true), "replayed");
    const old = signButton(key, { a: "stop", c: "oc_1", o: [], exp: Date.now() - 1 });
    assert.equal(verifyButton(key, old, { chatId: "oc_1", operator: FRIEND }, () => false), "expired");
    assert.equal(verifyButton(key, "nope", { chatId: "oc_1", operator: FRIEND }, () => false), "malformed");
  }

  // ── Agent defaults ───────────────────────────────────────────────────
  {
    const desktop = fakeRuntime().desktopPreferences();
    const claude = resolveAgent({}, desktop);
    assert.equal(claude.provider, "claude");
    assert.equal(claude.payload.model, "claude-x");
    assert.equal(claude.payload.claudeAccessMode, "acceptEdits");
    assert.equal(claude.payload.claudeExecutionMode, "execute");
    assert.equal(claude.payload.claudeReasoningEffort, "high");
    const grok = resolveAgent({ provider: "grok" }, desktop);
    assert.equal(grok.payload.grokPermissionMode, "yolo", "grok shares kimi's permission state");
    const chosen = resolveAgent({ provider: "codex", permissionMode: "fullAccess" }, desktop);
    assert.equal(chosen.payload.codexPermissionMode, "fullAccess");
    const plan = resolveAgent({ permissionMode: "plan" }, desktop);
    assert.equal(plan.payload.claudeExecutionMode, "plan");
  }

  // ── Turn rendering ───────────────────────────────────────────────────
  {
    const turn = new TurnState();
    turn.ingest({ type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "Mail me at dev@example.com" }] } });
    for (let i = 0; i < 4; i++)
      turn.ingest({ type: "assistant", uuid: `t${i}`, message: { content: [{ type: "tool_use", id: `tool${i}`, name: "Bash", input: { command: `echo ${i}` } }] } });
    turn.ingest({ type: "user", uuid: "u1", message: { content: [{ type: "tool_result", tool_use_id: "tool0", content: "0" }] } });
    turn.ingest({ type: "assistant", uuid: "sub", parentToolUseId: "task1", message: { content: [{ type: "text", text: "subagent text" }] } });
    const card = json(turnCard(turn, { stopToken: "fsb1.a.b" }));
    assert(card.includes("dev[at]example.com") && !card.includes("dev@example.com"), "emails are masked");
    assert(card.includes("4 tool calls"), "long tool runs collapse into one panel");
    assert(!card.includes("subagent text"), "subagent messages are not replies");
    assert(card.includes('"Stop"'), "running turns have a Stop button");
    turn.finish("done");
    const done = json(turnCard(turn));
    assert(!done.includes('"Stop"') && done.includes('"Done"'));
    const long = new TurnState();
    long.ingest({ type: "assistant", uuid: "l", message: { content: [{ type: "text", text: "x".repeat(CARD_ANSWER_LIMIT + 50) }] } });
    assert.equal(answerOverflow(long).length, 50, "text past the card limit is sent separately");
    assert.deepEqual(summarizePatch("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@\n+x\n-y\n+z\n"), [{ path: "a.ts", add: 2, del: 1 }]);
    assert.equal(maskEmails({ a: ["x@y.io"] }).a[0], "x[at]y.io");
    assert.equal(batchPrompt([{ senderId: "a", senderName: "A", text: "1" }, { senderId: "b", senderName: "B", text: "2" }]), "[A]: 1\n\n[B]: 2");
  }

  // ── Direct message → new task → streaming card → done ────────────────
  {
    const { runtime, transport, bridge, store } = setup("dm");
    await bridge.handleMessage(message({ senderId: STRANGER }));
    await wait(700);
    assert.equal(runtime.log.starts.length, 0, "strangers are ignored");
    assert.equal(transport.calls.markdown.length + transport.calls.cards.length, 0, "and get no reply");

    const first = message({ content: "fix the build" });
    await bridge.handleMessage(first);
    await bridge.handleMessage(message({ content: "and run tests" }));
    await wait(700);
    assert.equal(runtime.log.starts.length, 1, "messages within the quiet window are one batch");
    const start = runtime.log.starts[0];
    assert.equal(start.prompt, "fix the build\n\nand run tests");
    assert.equal(start.cwd, "/work/app");
    assert.equal(start.claudeAccessMode, "acceptEdits", "new tasks use the desktop's permission default");
    assert.equal(store.state.bindings.oc_dm.sessionId, "s1");
    assert.equal(transport.calls.reactions.length, 2, "each message gets a Typing reaction");

    bridge.capture({ type: "stream.user_prompt", payload: { sessionId: "s1", prompt: start.prompt } });
    bridge.capture({ type: "stream.message", payload: { sessionId: "s1", message: { type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/a.ts" } }] } } } });
    await wait(50);
    assert.equal(transport.calls.cards.length, 1, "the progress card appears with the first content");
    assert.equal(transport.calls.cards[0].target.replyTo, start ? transport.calls.reactions[1].messageId : undefined);
    bridge.capture({ type: "stream.message", payload: { sessionId: "s1", message: { type: "user", uuid: "u1", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } } } });
    runtime.sessions.get("s1").status = "completed";
    bridge.capture({ type: "session.status", payload: { sessionId: "s1", status: "completed" } });
    await wait(50);
    const last = transport.calls.updates.at(-1);
    assert(last && json(last.card).includes('"Done"') && !json(last.card).includes('"Stop"'), "the card ends as Done without Stop");
    assert.equal(transport.calls.removed.length, 2, "Typing reactions are removed at the end");

    // A follow-up continues the bound session.
    await bridge.handleMessage(message({ content: "thanks, now docs" }));
    await wait(700);
    assert.deepEqual(runtime.log.sends.at(-1), { sid: "s1", prompt: "thanks, now docs" });
    bridge.capture({ type: "stream.user_prompt", payload: { sessionId: "s1", prompt: "thanks, now docs" } });
    bridge.capture({ type: "session.status", payload: { sessionId: "s1", status: "completed" } });

    // A refused continue on an idle session keeps the binding (old bug: it was dropped).
    runtime.sendResult = false;
    await bridge.handleMessage(message({ content: "again" }));
    await wait(700);
    assert.equal(store.state.bindings.oc_dm?.sessionId, "s1", "binding survives a failed continue");
    assert(transport.calls.markdown.at(-1).text.includes("Couldn't send"));
    runtime.sendResult = true;

    // While running, messages wait and go as the next batch.
    runtime.sessions.get("s1").status = "running";
    bridge.capture({ type: "stream.user_prompt", payload: { sessionId: "s1", prompt: "x" } });
    const sendsBefore = runtime.log.sends.length;
    await bridge.handleMessage(message({ content: "queued one" }));
    await wait(700);
    assert.equal(runtime.log.sends.length, sendsBefore, "held while the run is active");
    runtime.sessions.get("s1").status = "completed";
    bridge.capture({ type: "session.status", payload: { sessionId: "s1", status: "completed" } });
    await wait(700);
    assert.equal(runtime.log.sends.at(-1).prompt, "queued one", "sent once the run ends");

    // /stop stops the run and drops queued messages.
    runtime.sessions.get("s1").status = "running";
    bridge.capture({ type: "stream.user_prompt", payload: { sessionId: "s1", prompt: "y" } });
    await bridge.handleMessage(message({ content: "will be dropped" }));
    await bridge.handleMessage(message({ content: "/stop" }));
    assert.deepEqual(runtime.log.stops, ["s1"]);
    assert(transport.calls.markdown.at(-1).text.includes("1 queued message was dropped"));

    // /new unbinds; the next message starts another task.
    await bridge.handleMessage(message({ content: "/new" }));
    assert.equal(store.state.bindings.oc_dm, undefined);
    bridge.close();
  }

  // ── Approvals and questions ──────────────────────────────────────────
  {
    const { runtime, transport, bridge } = setup("perm");
    await bridge.handleMessage(message({ content: "deploy" }));
    await wait(700);
    bridge.capture({ type: "stream.user_prompt", payload: { sessionId: "s1", prompt: "deploy" } });
    const toolInput = { kind: "codex-approval", approvalKind: "command", method: "claude.canUseTool", question: "Allow Claude to run this command?", title: "", toolName: "Bash", command: "rm -rf build", cwd: "/work/app", canAllowForSession: true };
    bridge.capture({ type: "permission.request", payload: { sessionId: "s1", toolUseId: "p1", toolName: "Bash", input: toolInput } });
    await wait(20);
    const prompt = transport.calls.cards.at(-1).card;
    assert(json(prompt).includes("rm -rf build"), "the card shows the exact command");
    assert.equal(click(bridge, prompt, "once", STRANGER).toast.type, "error", "others can't approve");
    const response = click(bridge, prompt, "once");
    assert.deepEqual(runtime.log.responses.at(-1).result, { behavior: "allow", scope: "once" }, "allow carries no updatedInput");
    assert.equal(response.card.type, "raw", "the card turns into its resolved state");
    assert.equal(click(bridge, prompt, "once").toast.content, "Already done.", "a token works once");

    bridge.capture({ type: "permission.request", payload: { sessionId: "s1", toolUseId: "p2", toolName: "Bash", input: toolInput } });
    await wait(20);
    click(bridge, transport.calls.cards.at(-1).card, "session");
    assert.deepEqual(runtime.log.responses.at(-1).result, { behavior: "allow", scope: "session" });

    const question = { questions: [{ question: "Which env?", options: [{ label: "staging" }, { label: "prod" }] }] };
    bridge.capture({ type: "permission.request", payload: { sessionId: "s1", toolUseId: "q1", toolName: "AskUserQuestion", input: question } });
    await wait(20);
    click(bridge, transport.calls.cards.at(-1).card, "q:1");
    assert.deepEqual(runtime.log.responses.at(-1).result, { behavior: "allow", updatedInput: { ...question, answers: { "Which env?": "prod" } } });

    const multi = { questions: [{ question: "Targets?", multiSelect: true, options: [{ label: "web" }, { label: "ios" }] }, { question: "Notify?", options: [{ label: "yes" }, { label: "no" }] }] };
    bridge.capture({ type: "permission.request", payload: { sessionId: "s1", toolUseId: "q2", toolName: "AskUserQuestion", input: multi } });
    await wait(20);
    const form = transport.calls.cards.at(-1).card;
    assert.equal(click(bridge, form, "submit", OWNER, "oc_dm", { q0: ["web"] }).toast.type, "warning", "every question needs an answer");
    click(bridge, form, "submit", OWNER, "oc_dm", { q0: ["web", "ios"], q1: "no" });
    assert.deepEqual(runtime.log.responses.at(-1).result.updatedInput.answers, { "Targets?": "web,ios", "Notify?": "no" });

    // Plan approval uses the plan text from the stream.
    bridge.capture({ type: "stream.message", payload: { sessionId: "s1", message: { type: "assistant", uuid: "pl", message: { content: [{ type: "tool_use", id: "ep", name: "ExitPlanMode", input: { plan: "1. Build\n2. Ship" } }] } } } });
    bridge.capture({ type: "permission.request", payload: { sessionId: "s1", toolUseId: "plan1", toolName: "ExitPlanMode", input: { questions: [{ question: "Approve this plan?", options: [{ label: "Approve and execute" }, { label: "Stay in plan mode" }] }] } } });
    await wait(20);
    const planCard = transport.calls.cards.map((c) => c.card).findLast((c) => json(c).includes("Approve the plan"));
    assert(json(planCard).includes("1. Build"), "the plan is shown");
    click(bridge, planCard, "q:0");
    assert.equal(runtime.log.responses.at(-1).result.updatedInput.answers["Approve this plan?"], "Approve and execute");

    // Answered on the desktop: the Feishu card closes.
    bridge.capture({ type: "permission.request", payload: { sessionId: "s1", toolUseId: "p3", toolName: "Bash", input: toolInput } });
    await wait(20);
    const updatesBefore = transport.calls.updates.length;
    bridge.capture({ type: "permission.dismissed", payload: { sessionId: "s1", toolUseId: "p3" } });
    await wait(20);
    assert(transport.calls.updates.slice(updatesBefore).some((u) => json(u.card).includes("Handled in Aegis on your Mac")));
    bridge.close();
  }

  // ── Groups, invites and topics ───────────────────────────────────────
  {
    const { runtime, transport, bridge, store } = setup("group");
    const group = (over) => message({ chatId: "oc_group", chatType: "group", chatMode: "group", ...over });
    await bridge.handleMessage(group({ senderId: FRIEND, content: "hi" }));
    assert.equal(transport.calls.markdown.length, 0, "no @mention, no reaction");
    await bridge.handleMessage(group({ senderId: FRIEND, mentionedBot: true, content: "hi" }));
    assert(transport.calls.markdown.at(-1).text.includes("/invite group"), "unconnected groups get a hint");
    await bridge.handleMessage(group({ senderId: FRIEND, mentionedBot: true, content: "hi again" }));
    assert.equal(transport.calls.markdown.length, 1, "the hint is not repeated");
    await bridge.handleMessage(group({ senderId: FRIEND, mentionedBot: true, content: "/invite group" }));
    assert.equal(transport.calls.markdown.length, 1, "people without access can't run commands");
    await bridge.handleMessage(group({ mentionedBot: true, content: "/invite group" }));
    assert.deepEqual(store.state.allowedChats, [{ chatId: "oc_group", name: "Team" }]);
    await bridge.handleMessage(group({ senderId: FRIEND, mentionedBot: true, content: "build it" }));
    await wait(700);
    assert.equal(runtime.log.starts.length, 1, "members of an invited group can start tasks");

    await bridge.handleMessage(message({ senderId: OWNER, content: "/invite", mentions: [{ key: "@_user_1", openId: FRIEND, name: "Friend" }] }));
    assert.deepEqual(store.state.allowedUsers, [{ openId: FRIEND, name: "Friend" }]);

    const topic = (thread, over) => message({ chatId: "oc_topics", chatType: "group", chatMode: "topic", threadId: thread, ...over });
    store.update((s) => s.allowedChats.push({ chatId: "oc_topics" }));
    await bridge.handleMessage(topic("omt_a", { mentionedBot: true, content: "topic A" }));
    await bridge.handleMessage(topic("omt_b", { mentionedBot: true, content: "topic B" }));
    await wait(700);
    assert(store.state.bindings["oc_topics:omt_a"] && store.state.bindings["oc_topics:omt_b"], "each topic is its own task");
    assert.notEqual(store.state.bindings["oc_topics:omt_a"].sessionId, store.state.bindings["oc_topics:omt_b"].sessionId);
    const topicA = store.state.bindings["oc_topics:omt_a"].sessionId;
    runtime.sessions.get(topicA).status = "completed";
    bridge.capture({ type: "session.status", payload: { sessionId: topicA, status: "completed" } });
    await bridge.handleMessage(topic("omt_a", { content: "follow-up without @" }));
    await wait(700);
    assert.equal(runtime.log.sends.at(-1).prompt, "follow-up without @", "inside a bound topic no @ is needed");
    bridge.close();
  }

  // ── Commands that open cards ─────────────────────────────────────────
  {
    const { transport, bridge, store } = setup("cmds");
    await bridge.handleMessage(message({ content: "/project" }));
    const projectCard = transport.calls.cards.at(-1).card;
    assert(json(projectCard).includes("app"));
    const changed = click(bridge, projectCard, "project");
    assert.equal(changed.toast.type, "success");
    assert.equal(store.state.prefs.oc_dm.cwd, "/work/app");
    await bridge.handleMessage(message({ content: "/agent" }));
    const agentCard = transport.calls.cards.at(-1).card;
    // The SDK dedupes clicks by message + operator + the first 128 chars of the value:
    // every button on a card must differ there, or a second button on the same card is dropped.
    const valuePrefixes = [...json(agentCard).matchAll(/"value":(\{"k":"[^"]+","t":"[^"]+"\})/g)].map((m) => m[1].slice(0, 128));
    assert(valuePrefixes.length > 3);
    assert.equal(new Set(valuePrefixes).size, valuePrefixes.length, "buttons on one card are distinguishable to the SDK's click dedupe");
    const codexToken = tokensOf(agentCard).find((t) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString()).d?.v === "codex");
    bridge.handleCardAction({ messageId: "x", chatId: "oc_dm", operator: { openId: OWNER }, action: { value: { t: codexToken }, tag: "button" } });
    assert.equal(store.state.prefs.oc_dm.provider, "codex");
    await bridge.handleMessage(message({ content: "/status" }));
    assert(json(transport.calls.cards.at(-1).card).includes("Codex"));
    await bridge.handleMessage(message({ content: "/help" }));
    assert(json(transport.calls.cards.at(-1).card).includes("/invite"), "the owner sees invite help");
    bridge.close();
  }

  // ── Aegis quits mid-run: the next start closes the live cards ────────
  {
    const { runtime, transport, bridge } = setup("restart");
    await bridge.handleMessage(message({ content: "delete test.txt" }));
    await wait(700);
    bridge.capture({ type: "stream.user_prompt", payload: { sessionId: "s1", prompt: "delete test.txt" } });
    bridge.capture({ type: "stream.message", payload: { sessionId: "s1", message: { type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "Deleting the file." }] } } } });
    await wait(50);
    bridge.capture({ type: "permission.request", payload: { sessionId: "s1", toolUseId: "p1", toolName: "Bash", input: { kind: "codex-approval", question: "Allow?", command: "rm test.txt", canAllowForSession: true } } });
    await wait(50);
    const turnCardId = transport.calls.cards[0].cardId;
    const promptCardId = transport.calls.cards[1].cardId;
    bridge.close();

    // A finished turn leaves nothing to clean up.
    const reopened = new FeishuStore(join(dir, "restart"), (x) => x, (x) => x);
    assert.deepEqual(Object.keys(reopened.state.openCards).sort(), [turnCardId, promptCardId].sort(), "live cards are remembered");
    const after = fakeTransport();
    const restarted = new FeishuBridge(reopened, fakeRuntime());
    restarted.attach(after);
    await wait(50);
    const turnUpdate = after.calls.updates.find((u) => u.cardId === turnCardId);
    assert(turnUpdate, "the progress card is updated");
    assert(json(turnUpdate.card).includes("Deleting the file."), "it keeps what it showed");
    assert(json(turnUpdate.card).includes("Interrupted") && !json(turnUpdate.card).includes('"Stop"'), "and is marked interrupted without Stop");
    const promptUpdate = after.calls.updates.find((u) => u.cardId === promptCardId);
    assert(promptUpdate && json(promptUpdate.card).includes("Aegis restarted") && !json(promptUpdate.card).includes("Allow once"), "the approval card ends");
    assert.equal(after.calls.markdown.length, 1, "the chat is told once");
    assert(after.calls.removed.length >= 1, "leftover Typing reactions are removed");
    assert.deepEqual(reopened.state.openCards, {});
    restarted.attach(after);
    await wait(20);
    assert.equal(after.calls.markdown.length, 1, "a reconnect doesn't repeat it");

    // Cards that finished normally are not touched on the next start.
    const { runtime: rt2, transport: t2, bridge: b2, store: st2 } = setup("restart-clean");
    await b2.handleMessage(message({ content: "quick one" }));
    await wait(700);
    b2.capture({ type: "stream.user_prompt", payload: { sessionId: "s1", prompt: "quick one" } });
    b2.capture({ type: "stream.message", payload: { sessionId: "s1", message: { type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "Done." }] } } } });
    await wait(50);
    rt2.sessions.get("s1").status = "completed";
    b2.capture({ type: "session.status", payload: { sessionId: "s1", status: "completed" } });
    await wait(50);
    assert.deepEqual(st2.state.openCards, {}, "finished turns are forgotten");
    b2.close();
    void runtime;
    void t2;
  }

  console.log("Feishu bridge: tokens, agent defaults, turn cards, batching, steer queue, approvals, questions, plans, groups, invites, topics, commands and restart recovery passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}


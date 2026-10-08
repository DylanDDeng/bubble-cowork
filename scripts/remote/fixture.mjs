// Deterministic transport/UI fixture. No provider calls or user project data.
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { createRelay } from "../../services/relay/server.mjs";
const require = createRequire(import.meta.url);
const {
  RemoteGateway,
} = require("../../dist-electron/electron/remote/gateway.js");
const {
  RemoteJournal,
} = require("../../dist-electron/electron/remote/journal.js");
const root = mkdtempSync(join(tmpdir(), "aegis-ios-fixture-"));
const token = randomBytes(32).toString("hex");
const fixturePort = Number(process.env.AEGIS_FIXTURE_PORT || 8788);
const offerPath = process.env.AEGIS_FIXTURE_OFFER || "/tmp/aegis-ios-pairing.txt";
const relay = createRelay({ port: fixturePort, registrationToken: token });
await relay.listen();
const minute = 60000;
const sessions = [
  {
    id: "design",
    projectId: "project",
    title: "Fix login redirect",
    provider: "codex",
    status: "running",
    updatedAt: Date.now(),
    runId: null,
  },
  {
    id: "stream",
    projectId: "project",
    title: "Refactor stream batching",
    provider: "codex",
    handoffSourceProvider: "claude",
    pinned: true,
    status: "idle",
    updatedAt: Date.now() - 6 * minute,
    runId: null,
  },
  {
    id: "tests",
    projectId: "project",
    title: "Add sync protocol tests",
    provider: "claude",
    status: "idle",
    updatedAt: Date.now() - 50 * minute,
    runId: null,
  },
  {
    id: "video",
    projectId: "site",
    title: "Stream large videos past the cap",
    provider: "codex",
    status: "error",
    updatedAt: Date.now() - 26 * 60 * minute,
    runId: null,
  },
  {
    id: "notes",
    projectId: "site",
    title: "Write this week’s release notes",
    provider: "bubble",
    status: "idle",
    updatedAt: Date.now() - 4 * 24 * 60 * minute,
    runId: null,
  },
];
const patch = [
  "diff --git a/src/auth/redirect.ts b/src/auth/redirect.ts",
  "--- a/src/auth/redirect.ts",
  "+++ b/src/auth/redirect.ts",
  "@@ -38,8 +38,11 @@ export function resolveReturnTo(req: Request) {",
  " export function resolveReturnTo(req: Request) {",
  "-  const session = refreshSession(req);",
  "-  const target = req.cookies.returnTo;",
  "+  // Read before the refresh clears cookies.",
  "+  const target = sanitizeReturnTo(req.cookies.returnTo);",
  "+  const session = refreshSession(req);",
  "   if (!session) {",
  '     return "/login";',
  "   }",
  '-  return target ?? "/";',
  "+  return target;",
  " }",
  "diff --git a/src/auth/redirect.test.ts b/src/auth/redirect.test.ts",
  "--- a/src/auth/redirect.test.ts",
  "+++ b/src/auth/redirect.test.ts",
  "@@ -12,0 +13,4 @@",
  '+it("keeps same-site paths", () => {',
  '+  expect(sanitizeReturnTo("/billing")).toBe("/billing");',
  '+  expect(sanitizeReturnTo("//evil.test")).toBe("/");',
  "+});",
].join("\n");
const t0 = Date.now() - 9 * minute;
const history = {
  design: [
    {
      id: "u1",
      role: "user",
      at: t0,
      text: "After signing in, people always land on the home page. Keep the page they came from, and add a test for it.",
    },
    { id: "a0", role: "assistant", at: t0 + 4000, text: "I’ll trace where the redirect target gets lost, fix it, then cover it with a test." },
    { id: "t1", role: "tool", kind: "tool_use", name: "Read", at: t0 + 6000, text: 'Read\n{\n  "file_path": "/fixture/aegis/src/auth/redirect.ts"\n}' },
    { id: "r1", role: "tool", kind: "tool_result", at: t0 + 7000, text: "export function resolveReturnTo(req: Request) { … }" },
    { id: "t2", role: "tool", kind: "tool_use", name: "Grep", at: t0 + 9000, text: 'Grep\n{\n  "pattern": "returnTo"\n}' },
    { id: "r2", role: "tool", kind: "tool_result", at: t0 + 10000, text: "6 files" },
    { id: "t3", role: "tool", kind: "tool_use", name: "Edit", at: t0 + 40000, text: 'Edit\n{\n  "file_path": "/fixture/aegis/src/auth/redirect.ts"\n}' },
    { id: "r3", role: "tool", kind: "tool_result", at: t0 + 41000, text: "Updated" },
    { id: "c1", role: "tool", kind: "changes", at: t0 + 60000, text: patch },
    {
      id: "a1",
      role: "assistant",
      at: t0 + 64000,
      text: "### Login now returns you to where you were\n\nThe target was read after the session refresh cleared the cookie. It’s now read first and checked by `sanitizeReturnTo`, which only accepts same-site paths.\n\n- Refresh no longer drops the target\n- External and protocol-relative URLs fall back to `/`\n\nI’d like to run the auth tests to confirm.",
    },
  ],
  stream: [
    { id: "u2", role: "user", text: "Batch stream deltas per animation frame instead of per token." },
    { id: "a2", role: "assistant", text: "Done. Deltas are coalesced per frame and flushed on turn end, so the last token is never held back." },
  ],
  tests: [
    { id: "u3", role: "user", text: "Check that a repeated command never starts two tasks." },
    { id: "a3", role: "assistant", text: "Verified. Replaying the same command ID runs it once; reusing the ID with a different payload is rejected." },
  ],
  video: [
    { id: "u4", role: "user", text: "Stream videos over 200 MB instead of failing the preview." },
  ],
  notes: [{ id: "a5", role: "assistant", text: "Release notes drafted in RELEASE_NOTES.md." }],
};
let pending = true;
let gateway;
const runtime = {
  environment: "fixture",
  projects: () => [
    { id: "project", name: "coworker", path: "/fixture/coworker", isRepo: true },
    { id: "site", name: "aegis-site", path: "/fixture/aegis-site", isRepo: false },
  ],
  // Catalog shaped like the host's: no endpoints or keys.
  options: async () => ({
    claude: { defaultModel: null, options: ["opus", "sonnet", "haiku"], compatible: [{ id: "moonshot", model: "kimi-k2" }] },
    codex: {
      defaultModel: "gpt-5-codex",
      defaultReasoningEffort: "medium",
      options: ["gpt-5-codex", "gpt-5"],
      availableModels: [
        { name: "gpt-5-codex", label: "GPT-5 Codex", enabled: true, isDefault: true, defaultReasoningEffort: "medium", supportedReasoningLevels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }], supportsFastMode: true },
        { name: "gpt-5", label: "GPT-5", enabled: true, isDefault: false, defaultReasoningEffort: "medium", supportedReasoningLevels: [{ effort: "minimal" }, { effort: "low" }, { effort: "medium" }, { effort: "high" }] },
      ],
    },
    bubble: { defaultModel: "deepseek-v4-flash", options: [], availableModels: [{ name: "deepseek-v4-flash", label: "DeepSeek V4 Flash", enabled: true, isDefault: true, reasoningLevels: ["low", "high", "max"], defaultReasoningLevel: "high" }] },
  }),
  attach: async (name, data) => ({
    id: crypto.randomUUID(),
    path: join(root, name),
    name,
    size: data.byteLength,
    mimeType: /\.(png|jpe?g|gif|webp)$/i.test(name) ? "image/png" : "application/octet-stream",
    kind: /\.(png|jpe?g|gif|webp)$/i.test(name) ? "image" : "file",
  }),
  sessions: () => sessions,
  history: (id) => history[id] || [],
  confirm: async () => true,
  hasPermission: () => pending,
  start: async (project, provider, prompt, extras) => {
    console.log("fixture start", provider, JSON.stringify({ settings: extras?.settings, worktree: extras?.worktree, attachments: extras?.attachments?.map((a) => a.name) }));
    const id = crypto.randomUUID();
    sessions.unshift({
      id,
      projectId: project.id,
      title: prompt.slice(0, 30),
      provider,
      status: "running",
      updatedAt: Date.now(),
      runId: null,
    });
    history[id] = [{ id: crypto.randomUUID(), role: "user", text: prompt }];
    gateway.capture({
      type: "stream.user_prompt",
      payload: { sessionId: id, prompt },
    });
    setTimeout(() => {
      history[id].push({
        id: crypto.randomUUID(),
        role: "assistant",
        text: "This reply comes from the isolated test host. The task was received once.",
      });
      sessions.find((s) => s.id === id).status = "idle";
      gateway.capture({
        type: "session.status",
        payload: { sessionId: id, status: "idle" },
      });
    }, 800);
    return id;
  },
  send: async (id, prompt, extras) => {
    console.log("fixture send", JSON.stringify({ settings: extras?.settings, attachments: extras?.attachments?.map((a) => a.name) }));
    history[id].push(
      { id: crypto.randomUUID(), role: "user", text: prompt },
      {
        id: crypto.randomUUID(),
        role: "assistant",
        text: "Got the follow-up. The test session is updated.",
      },
    );
    gateway.capture({
      type: "session.status",
      payload: { sessionId: id, status: "idle" },
    });
    return true;
  },
  stop: (id) => {
    sessions.find((s) => s.id === id).status = "idle";
    pending = false;
    gateway.capture({
      type: "session.status",
      payload: { sessionId: id, status: "idle" },
    });
  },
  permission: () => {
    pending = false;
    gateway.capture({
      type: "permission.dismissed",
      payload: { sessionId: "design", toolUseId: "check" },
    });
    return true;
  },
};
gateway = new RemoteGateway(
  new RemoteJournal(
    join(root, "journal"),
    (x) => x,
    (x) => x,
  ),
  runtime,
);
await gateway.configure(`ws://127.0.0.1:${fixturePort}`, token);
await new Promise((r) => setTimeout(r, 400));
gateway.capture({
  type: "stream.user_prompt",
  payload: { sessionId: "design", prompt: "test" },
});
gateway.capture({
  type: "permission.request",
  payload: {
    sessionId: "design",
    toolUseId: "check",
    toolName: "Bash",
    input: { command: "npm run test -- src/auth/redirect.test.ts", cwd: "/fixture/coworker" },
  },
});
const publish = () => {
  const offer = gateway.pairing();
  writeFileSync(
    offerPath,
    "aegis://pair#" + encodeURIComponent(JSON.stringify(offer)),
    { mode: 0o600 },
  );
};
publish();
const timer = setInterval(() => {
  if (["waiting", "connected"].includes(gateway.status)) publish();
}, 90000);
console.log(
  `Isolated UI fixture ready; pairing offer: ${offerPath}`,
);
process.on("SIGTERM", () => {
  clearInterval(timer);
  gateway.close();
  void relay.close().then(() => process.exit(0));
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  RemoteGateway,
} = require("../../dist-electron/electron/remote/gateway.js");
const {
  RemoteJournal,
} = require("../../dist-electron/electron/remote/journal.js");
const {
  remoteTaskPayload,
} = require("../../dist-electron/electron/remote/task-payload.js");
const dir = mkdtempSync(join(tmpdir(), "aegis-remote-tests-"));
// A small project for the read-only file requests.
const projectDir = join(dir, "project");
mkdirSync(join(projectDir, "src"), { recursive: true });
mkdirSync(join(projectDir, "node_modules", "pkg"), { recursive: true });
writeFileSync(join(projectDir, "README.md"), "# Hello\n");
writeFileSync(join(projectDir, "src", "app.ts"), "export const x = 1;\n");
writeFileSync(join(projectDir, "src", "logo.bin"), Buffer.from([1, 0, 2, 3]));
writeFileSync(join(projectDir, ".env"), "SECRET=1\n");
writeFileSync(join(projectDir, "node_modules", "pkg", "app.js"), "x");
writeFileSync(join(dir, "outside.txt"), "outside\n");
symlinkSync(join(dir, "outside.txt"), join(projectDir, "escape.txt"));
let lastExtras;
let starts = 0,
  sends = 0,
  stops = 0,
  approvals = 0,
  pending = true;
const sessions = [
  {
    id: "visible",
    projectId: "allowed",
    title: "Visible",
    provider: "claude",
    status: "idle",
    updatedAt: 1,
    runId: null,
  },
  {
    id: "secret",
    projectId: "hidden",
    title: "Secret",
    provider: "claude",
    status: "running",
    updatedAt: 1,
    runId: null,
  },
];
const runtime = {
  projects: () => [
    { id: "allowed", name: "Allowed", path: projectDir },
    { id: "hidden", name: "Hidden", path: "/hidden" },
  ],
  sessions: () => sessions,
  history: () => [{ id: "one", role: "assistant", text: "hello" }],
  start: async (_project, _provider, _prompt, extras) => {
    lastExtras = extras;
    starts++;
    await new Promise((r) => setTimeout(r, 20));
    return "new";
  },
  send: async () => {
    sends++;
    return true;
  },
  stop: () => {
    stops++;
  },
  permission: () => {
    approvals++;
    pending = false;
    return true;
  },
  hasPermission: () => pending,
  confirm: async () => true,
  options: async () => ({ codex: { defaultModel: "m", defaultReasoningEffort: null, options: ["m"], availableModels: [] } }),
  attach: async (name, data) => ({ id: "a1", path: "/tmp/" + name, name, size: data.byteLength, mimeType: "image/png", kind: "image" }),
};
const journal = new RemoteJournal(
  join(dir, "state"),
  (x) => x,
  (x) => x,
);
journal.update((s) => {
  s.config = { enabled: true, projectIds: ["allowed"] };
  s.devices = [{ peerId: "phone", name: "test", pairedAt: 1 }];
});
const gateway = new RemoteGateway(journal, runtime);
let sequence = 0;
const request = (data, peer = "phone") =>
  gateway.dispatch({ id: String(++sequence), ...data }, peer);
const command = (data) => ({
  commandId: crypto.randomUUID(),
  expiresAt: Date.now() + 60000,
  ...data,
});
try {
  assert.equal(
    (await request({ method: "snapshot" }, "attacker")).error,
    "UNAUTHORIZED",
  );
  const snapshot = (await request({ method: "snapshot" })).result;
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.projects.length, 1);
  assert.equal(snapshot.sessions[0].id, "visible");
  assert.equal(
    (await request({ method: "snapshot", sessionId: "secret" })).error,
    "SCOPE_DENIED",
  );
  assert.equal(
    (await request({ method: "session.delete", sessionId: "visible" })).error,
    "INVALID_REQUEST",
  );
  assert.equal(
    (
      await request(
        command({
          method: "create",
          projectId: "hidden",
          provider: "claude",
          prompt: "x",
        }),
      )
    ).error,
    "SCOPE_DENIED",
  );
  const create = command({
    method: "create",
    projectId: "allowed",
    provider: "claude",
    prompt: "Run once",
  });
  const [first, duplicate] = await Promise.all([
    request(create),
    request(create),
  ]);
  assert.equal(starts, 1);
  assert.equal(first.result.state, "completed");
  assert.equal(duplicate.result.state, "accepted");
  assert.equal(
    (await request({ ...create, prompt: "Different" })).error,
    "COMMAND_MISMATCH",
  );
  assert.equal(
    (await request({ method: "command.get", commandId: create.commandId }))
      .result.state,
    "completed",
  );
  assert.equal(
    (
      await request(
        command({
          method: "send",
          sessionId: "visible",
          prompt: "x",
          expiresAt: 1,
        }),
      )
    ).error,
    "COMMAND_EXPIRED",
  );
  sessions[0].status = "running";
  gateway.capture({
    type: "stream.user_prompt",
    payload: { sessionId: "visible", prompt: "Run" },
  });
  const runId = gateway.snapshot().sessions[0].runId;
  assert.equal(
    (
      await request(
        command({ method: "send", sessionId: "visible", prompt: "x" }),
      )
    ).error,
    "SESSION_BUSY",
  );
  assert.equal(
    (
      await request(
        command({ method: "stop", sessionId: "visible", runId: "old" }),
      )
    ).error,
    "STALE_RUN",
  );
  await request(command({ method: "stop", sessionId: "visible", runId }));
  assert.equal(stops, 1);
  gateway.capture({
    type: "permission.request",
    payload: {
      sessionId: "visible",
      toolUseId: "tool",
      toolName: "Bash",
      input: { command: "pwd" },
    },
  });
  const permission = gateway.snapshot().permissions[0];
  assert(permission);
  const approve = command({
    method: "permission",
    sessionId: "visible",
    runId,
    requestId: permission.requestId,
    decision: "allow",
  });
  await Promise.all([request(approve), request(approve)]);
  assert.equal(approvals, 1);
  assert.equal(gateway.snapshot().permissions.length, 0);
  pending = true;
  gateway.capture({
    type: "permission.request",
    payload: {
      sessionId: "visible", toolUseId: "long-tool", toolName: "Bash",
      input: { command: "x".repeat(25000) },
    },
  });
  const longPermission = gateway.snapshot().permissions[0];
  assert.equal(longPermission.canApprove, false);
  assert.equal((await request(command({
    method: "permission", sessionId: "visible", runId,
    requestId: longPermission.requestId, decision: "allow",
  }))).error, "DESKTOP_REQUIRED");
  assert.equal(approvals, 1, "A truncated request must never be approved remotely");
  journal.update((s) => {
    s.commands.crashed = {
      fingerprint: "hash",
      result: { commandId: "crashed", state: "accepted" },
      expiresAt: Date.now() + 1000,
    };
  });
  const restored = new RemoteJournal(
    join(dir, "state"),
    (x) => x,
    (x) => x,
  );
  assert.equal(restored.state.commands.crashed.result.state, "unknown");
  // Agent catalog and chunked uploads.
  assert.equal((await request({ method: "options" })).result.codex.defaultModel, "m");
  assert.equal((await request({ method: "options" }, "attacker")).error, "UNAUTHORIZED");
  const chunk = (data) => request({ method: "attachment.chunk", name: "shot.png", ...data });
  assert.equal((await chunk({ uploadId: "u1", index: 1, total: 2, data: "AAAA" })).error, "UPLOAD_EXPIRED");
  assert.deepEqual((await chunk({ uploadId: "u1", index: 0, total: 2, data: "AAAA" })).result, { received: 1 });
  assert.equal((await request({ method: "attachment.chunk", name: "shot.png", uploadId: "u1", index: 1, total: 2, data: "AAAA" }, "attacker")).error, "UNAUTHORIZED");
  assert.equal((await chunk({ uploadId: "u1", index: 0, total: 2, data: "AAAA" })).error, "UPLOAD_OUT_OF_ORDER");
  const done = (await chunk({ uploadId: "u1", index: 1, total: 2, data: "AAAA" })).result;
  assert.equal(done.size, 6);
  assert.ok(done.attachmentId);
  const withAttachment = await request(
    command({ method: "create", projectId: "allowed", provider: "claude", prompt: "Look", settings: { effort: "high", plan: true }, worktree: true, attachmentIds: [done.attachmentId] }),
  );
  assert.equal(withAttachment.result.state, "completed");
  assert.equal(lastExtras.attachments[0].name, "shot.png");
  assert.equal(lastExtras.settings.effort, "high");
  assert.equal(lastExtras.worktree, true);
  assert.equal(
    (await request(command({ method: "create", projectId: "allowed", provider: "claude", prompt: "x", attachmentIds: ["missing"] }))).error,
    "ATTACHMENT_EXPIRED",
  );
  const big = "A".repeat(131072);
  let tooLarge;
  for (let i = 0; i < 120 && !tooLarge; i++) {
    const r = await chunk({ uploadId: "u2", index: i, total: 120, data: big });
    if (r.error) tooLarge = r.error;
  }
  assert.equal(tooLarge, "ATTACHMENT_TOO_LARGE");
  // Read-only project files: scoped, no dot entries, no escapes.
  const files = (data, peer) => request(data, peer);
  const root = (await files({ method: "files.list", projectId: "allowed" })).result;
  assert.deepEqual(root.map((e) => `${e.kind}:${e.path}`), ["dir:node_modules", "dir:src", "file:README.md"]);
  assert.deepEqual((await files({ method: "files.list", projectId: "allowed", path: "src" })).result.map((e) => e.path), ["src/app.ts", "src/logo.bin"]);
  assert.equal((await files({ method: "files.read", projectId: "allowed", path: "src/app.ts" })).result.text, "export const x = 1;\n");
  assert.equal((await files({ method: "files.read", projectId: "allowed", path: join(projectDir, "README.md") })).result.path, "README.md");
  assert.equal((await files({ method: "files.read", projectId: "allowed", path: "src/logo.bin" })).result.text, null);
  assert.equal((await files({ method: "files.read", projectId: "allowed", path: "../outside.txt" })).error, "SCOPE_DENIED");
  assert.equal((await files({ method: "files.read", projectId: "allowed", path: "escape.txt" })).error, "SCOPE_DENIED");
  assert.equal((await files({ method: "files.read", projectId: "allowed", path: ".env" })).error, "SCOPE_DENIED");
  assert.equal((await files({ method: "files.read", projectId: "allowed", path: "missing.ts" })).error, "NOT_FOUND");
  assert.equal((await files({ method: "files.list", projectId: "hidden" })).error, "SCOPE_DENIED");
  assert.equal((await files({ method: "files.list", projectId: "allowed" }, "attacker")).error, "UNAUTHORIZED");
  assert.deepEqual((await files({ method: "files.search", projectId: "allowed", query: "APP" })).result.map((e) => e.path), ["src/app.ts"]);
  // Phone settings map onto the desktop composer's payload fields.
  assert.deepEqual(remoteTaskPayload("codex", { settings: { model: "m", effort: "high", fast: true, permissionMode: "fullAccess", plan: true } }), {
    model: "m", attachments: undefined, codexPermissionMode: "fullAccess", codexExecutionMode: "plan", codexReasoningEffort: "high", codexFastMode: true,
  });
  assert.equal(remoteTaskPayload("claude", { settings: { permissionMode: "yolo", effort: "ultra" } }).claudeAccessMode, "default");
  assert.equal(remoteTaskPayload("claude", { settings: { effort: "ultra" } }).claudeReasoningEffort, undefined);
  const bubble = remoteTaskPayload("bubble", { settings: { permissionMode: "bypassPermissions", plan: true, effort: "max" } });
  assert.equal(bubble.bubblePermissionMode, "plan");
  assert.equal(bubble.bubblePlanExitMode, "bypassPermissions");
  assert.equal(bubble.bubbleThinkingLevel, "max");
  const devin = remoteTaskPayload("devin", { settings: { model: "swe-1.5", permissionMode: "plan", effort: "high" } });
  assert.deepEqual(devin, { model: "swe-1.5", attachments: undefined, devinPermissionMode: "plan", devinThoughtLevel: "high" });
  assert.equal(remoteTaskPayload("devin", { settings: { permissionMode: "yolo" } }).devinPermissionMode, "accept-edits");
  // Phone approvals must not swap the tool's real input for the approval card's fields.
  const ipcSource = (await import("node:fs")).readFileSync(join(process.cwd(), "src/electron/ipc-handlers.ts"), "utf8");
  assert(!ipcSource.includes("updatedInput: request.input"), "phone approvals keep the tool's own input");
  gateway.revoke("phone");
  assert.equal((await request({ method: "snapshot" })).error, "UNAUTHORIZED");
  console.log(
    "Gateway: authorization, scope isolation, whitelist, deduplication, payload conflicts, expiry, stale-run stop, approval race, crash recovery, agent catalog, chunked uploads, task settings and revocation passed",
  );
} finally {
  gateway.close();
  rmSync(dir, { recursive: true, force: true });
}

// Tests the bundled aegis-core.js the way the app uses it: load into a fresh
// global scope and call the JSON-in/JSON-out API.  node --test apps/ios/core
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("../AegisKit/Sources/AegisKit/Resources/aegis-core.js", import.meta.url)), "utf8");
const context = {};
runInNewContext(source, context);
const call = (name, input) => JSON.parse(context.AegisCore[name](JSON.stringify(input)));

const prompt = (uuid, text, createdAt) => ({ id: uuid, role: "user", text, raw: { type: "user_prompt", uuid, prompt: text, createdAt } });
const toolUse = (uuid, id, command, createdAt) => ({
  id: uuid, role: "assistant", text: "",
  raw: { type: "assistant", uuid, createdAt, message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } },
});
const toolResult = (uuid, id, content, createdAt, isError = false) => ({
  id: uuid, role: "tool", text: "",
  raw: { type: "user", uuid, createdAt, message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } },
});
const answer = (uuid, text, createdAt) => ({
  id: uuid, role: "assistant", text,
  raw: { type: "assistant", uuid, createdAt, message: { content: [{ type: "text", text }] } },
});

test("completed turn: prompt, collapsible work block, answer", () => {
  const model = call("renderSession", {
    messages: [prompt("p1", "Run the tests", 1000), toolUse("a1", "t1", "npm test", 2000), toolResult("r1", "t1", "ok", 3000), answer("a2", "All green.", 64000)],
    running: false,
    status: "idle",
  });
  assert.equal(model.structured, true);
  assert.deepEqual(model.items.map((i) => i.kind), ["user", "work", "answer"]);
  const work = model.items[1].work;
  assert.match(work.label, /^Worked for /);
  assert.equal(work.defaultExpanded, false);
  const stage = work.groups[0].stages[0];
  assert.equal(stage.icon, "command");
  assert.equal(stage.commands[0].text, "$ npm test\nok");
  assert.equal(model.lastAnswerText, "All green.");
});

test("running turn stays expanded and shows progress", () => {
  const model = call("renderSession", {
    messages: [prompt("p1", "Run the tests", 1000), toolUse("a1", "t1", "npm test", 2000)],
    running: true,
    status: "running",
  });
  const work = model.items.find((i) => i.kind === "work").work;
  assert.equal(work.label, null);
  assert.equal(work.defaultExpanded, true);
  assert.equal(work.groups[0].stages[0].status, "pending");
});

test("failed command is flagged", () => {
  const model = call("renderSession", {
    messages: [prompt("p1", "x", 1), toolUse("a1", "t1", "false", 2), toolResult("r1", "t1", "boom", 3, true), answer("a2", "It failed.", 4)],
    running: false,
    status: "idle",
  });
  const group = model.items.find((i) => i.kind === "work").work.groups[0];
  assert.equal(group.stages[0].commands[0].isError, true);
});

test("legacy hosts without raw fall back to text rows", () => {
  const model = call("renderSession", {
    messages: [
      { id: "1", role: "user", text: "hi" },
      { id: "2", role: "tool", text: "ls output" },
      { id: "3", role: "tool", text: "more" },
      { id: "4", role: "assistant", text: "hello" },
    ],
    running: true,
    status: "stopping",
  });
  assert.equal(model.structured, false);
  assert.deepEqual(model.items.map((i) => i.kind), ["user", "activity", "answer", "working"]);
  assert.equal(model.items[1].steps.length, 2);
  assert.equal(model.items[3].label, "Stopping…");
});

test("a finished turn with edits gets the desktop's files-changed card", () => {
  const changes = { "/repo/a.ts": { type: "update", unified_diff: "@@ -1,2 +1,2 @@\n x\n-old\n+new\n" } };
  const edit = (uuid, id, at) => ({
    id: uuid, role: "assistant", text: "",
    raw: { type: "assistant", uuid, createdAt: at, message: { content: [{ type: "tool_use", id, name: "Edit", input: JSON.stringify({ changes }) }] } },
  });
  const turn = [prompt("p1", "fix", 1), edit("a1", "e1", 2), toolResult("r1", "e1", JSON.stringify({ output: "Done", changes }), 3), answer("a2", "Fixed.", 4)];
  const done = call("renderSession", { messages: turn, running: false, status: "idle" });
  assert.deepEqual(done.items.map((i) => i.kind), ["user", "work", "answer", "changes"]);
  const card = done.items[3];
  assert.deepEqual(card.files.map((f) => [f.path, f.additions, f.deletions]), [["/repo/a.ts", 1, 1]]);
  assert.match(card.files[0].diff, /\+new/);
  // The card waits while the turn is still running.
  const live = call("renderSession", { messages: turn.slice(0, 3), running: true, status: "running" });
  assert.ok(!live.items.some((i) => i.kind === "changes"));
  const files = call("parsePatch", { patch: "--- a/a.ts\n+++ b/a.ts\n" + card.files[0].diff });
  assert.deepEqual(files[0].lines.map((l) => l.type), ["hunk", "ctx", "del", "add"]);
});

test("catalog evaluates per-model efforts and fast mode", () => {
  const codex = call("catalog", {
    provider: "codex",
    options: {
      codex: {
        defaultModel: "gpt-5-codex",
        defaultReasoningEffort: "medium",
        options: [],
        availableModels: [
          { name: "gpt-5-codex", label: "GPT-5 Codex", enabled: true, isDefault: true, supportedReasoningLevels: [{ effort: "low" }, { effort: "high" }], supportsFastMode: true },
        ],
      },
    },
  });
  assert.equal(codex.defaultModel, "gpt-5-codex");
  assert.deepEqual(codex.perModel["gpt-5-codex"].efforts.map((e) => e.value), ["low", "high"]);
  assert.equal(codex.perModel["gpt-5-codex"].fast, true);
  assert.ok(codex.permissionModes.length > 0);
  const claude = call("catalog", { provider: "claude" });
  assert.equal(claude.models[0].label, "Default");
});

test("Codex edits name the file and count lines, like the desktop", () => {
  // Shape recorded from a real Codex session: the Edit input is a JSON string and
  // the result repeats the change set next to the output text.
  const changes = { "/repo/index.html": { type: "update", unified_diff: "@@ -1,2 +1,2 @@\n a\n-old\n+new\n" } };
  const input = JSON.stringify({ changes });
  const model = call("renderSession", {
    messages: [
      prompt("p1", "Edit a file", 1),
      { id: "a1", role: "assistant", text: "", raw: { type: "assistant", uuid: "a1", createdAt: 2, message: { content: [{ type: "tool_use", id: "e1", name: "Edit", input }] } } },
      toolResult("r1", "e1", JSON.stringify({ output: "Done", changes }), 3),
      answer("a2", "Edited.", 4),
    ],
    running: false,
    status: "idle",
  });
  const stage = model.items.find((i) => i.kind === "work").work.groups[0].stages[0];
  assert.equal(stage.title, "Edited index.html");
  assert.deepEqual(stage.files.map((f) => [f.name, f.addedLines, f.removedLines]), [["index.html", 1, 1]]);
  assert.equal(stage.genericText, "");
});

test("Devin catalog: models and thinking levels from the Mac, plan as a mode", () => {
  const devin = call("catalog", {
    provider: "devin",
    options: {
      devin: {
        defaultModel: "swe",
        availableModels: [{ id: "swe", label: "SWE" }, { id: "opus", label: "Opus" }],
        thoughtLevels: { swe: { levels: [], defaultLevel: null }, opus: { levels: [{ id: "low", label: "Low" }, { id: "high", label: "High" }], defaultLevel: "high" } },
      },
    },
  });
  assert.deepEqual(devin.models.map((m) => m.label), ["Default", "SWE", "Opus"]);
  assert.deepEqual(devin.perModel[""].efforts, []);
  assert.deepEqual(devin.perModel.opus.efforts.map((e) => e.value), ["low", "high"]);
  assert.equal(devin.perModel.opus.defaultEffort, "high");
  assert.equal(devin.defaultPermission, "accept-edits");
  assert.ok(devin.permissionModes.some((p) => p.mode === "plan"));
  assert.equal(devin.supportsPlan, false);
});

test("MiMo catalog: models and variant levels from the Mac, plan as a mode", () => {
  const mimo = call("catalog", {
    provider: "mimo",
    options: {
      mimo: {
        defaultModel: "xiaomi/mimo-v2.6-pro",
        availableModels: [
          { id: "xiaomi/mimo-v2.6-pro", label: "MiMo-V2.6-Pro", reasoningEfforts: ["low", "medium", "high"] },
          { id: "anthropic/claude", label: "Claude", reasoningEfforts: [] },
        ],
      },
    },
  });
  assert.deepEqual(mimo.models.map((m) => m.label), ["Default", "MiMo-V2.6-Pro", "Claude"]);
  // The Default row offers the configured default model's levels.
  assert.deepEqual(mimo.perModel[""].efforts.map((e) => e.value), ["low", "medium", "high"]);
  assert.deepEqual(mimo.perModel["xiaomi/mimo-v2.6-pro"].efforts.map((e) => e.label), ["Low", "Medium", "High"]);
  assert.equal(mimo.perModel["xiaomi/mimo-v2.6-pro"].defaultEffort, null);
  assert.deepEqual(mimo.perModel["anthropic/claude"].efforts, []);
  assert.equal(mimo.defaultPermission, "ask");
  assert.deepEqual(mimo.permissionModes.map((p) => p.mode), ["ask", "plan", "build"]);
  assert.equal(mimo.supportsPlan, false);
});

test("errors come back as values", () => {
  assert.ok(JSON.parse(context.AegisCore.renderSession("not json")).error);
});

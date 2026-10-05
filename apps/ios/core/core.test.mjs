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

test("turn changes become a changes card keyed by the message uuid", () => {
  const patch = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-a\n+b\n c";
  const model = call("renderSession", {
    messages: [prompt("p1", "x", 1), { id: "c1", role: "system", text: "", raw: { type: "system", subtype: "turn_changes", uuid: "c1", createdAt: 2, turnChanges: { patch, truncated: false } } }],
    running: false,
    status: "idle",
  });
  const changes = model.items.find((i) => i.kind === "changes");
  assert.deepEqual(changes, { kind: "changes", id: "c1", files: [{ path: "x.ts", additions: 1, deletions: 1 }] });
  const files = call("parsePatch", { patch });
  assert.deepEqual(files[0].lines.map((l) => l.type), ["hunk", "del", "add", "ctx"]);
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

test("errors come back as values", () => {
  assert.ok(JSON.parse(context.AegisCore.renderSession("not json")).error);
});

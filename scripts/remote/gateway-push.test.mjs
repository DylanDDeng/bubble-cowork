// Desktop gateway against relay v2: key-derived room (with migration), push registration and triggers.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createRelay } from "../../services/relay/server.mjs";
import { hostRoom } from "./relay-host.mjs";
const require = createRequire(import.meta.url);
const { RemoteGateway } = require("../../dist-electron/electron/remote/gateway.js");
const { RemoteJournal } = require("../../dist-electron/electron/remote/journal.js");
const { createIdentity } = require("../../dist-electron/electron/remote/secure-channel.cjs");

const dir = mkdtempSync(join(tmpdir(), "aegis-remote-push-"));
const relay = createRelay({ port: 0 });
const { port } = await relay.listen();
const identity = await createIdentity();
const sessions = [
  { id: "shared", projectId: "allowed", title: "Shared", provider: "claude", status: "idle", updatedAt: 1, runId: null },
  { id: "private", projectId: "hidden", title: "Private", provider: "claude", status: "idle", updatedAt: 1, runId: null },
];
const runtime = {
  projects: () => [{ id: "allowed", name: "Allowed", path: dir }],
  sessions: () => sessions,
  history: () => [],
  start: async () => null,
  send: async () => true,
  stop: () => {},
  permission: () => true,
  hasPermission: () => true,
  confirm: async () => true,
};
const journal = new RemoteJournal(join(dir, "state"), (x) => x, (x) => x);
journal.update((s) => {
  s.config = {
    enabled: true,
    relay: `ws://127.0.0.1:${port}/`,
    // A pre-v2 config: random room, no registration token needed by an open relay.
    room: "0".repeat(32),
    routeToken: "r".repeat(64),
    identity: identity.privateKey,
    peerId: identity.peerId,
  };
  s.devices = [
    { peerId: "phone", name: "Phone", pairedAt: 1 },
    { peerId: "old-phone", name: "Old", pairedAt: 1, push: { deviceToken: "ab".repeat(32), topic: "ai.aegis.companion", environment: "production" } },
  ];
});
const gateway = new RemoteGateway(journal, runtime);
const pushes = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  pushes.push({ url, body: JSON.parse(init.body), signature: init.headers["X-Aegis-Signature"] });
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
try {
  gateway.connect();
  for (let i = 0; i < 100 && gateway.status !== "waiting"; i++) await settle();
  assert.equal(gateway.status, "waiting");
  // The room migrated to the one derived from the host key, and the relay knows it.
  assert.equal(journal.state.config.room, hostRoom(identity.privateKey));
  assert(relay.rooms.has(journal.state.config.room));

  // A token moves to the phone that registers it.
  const registered = await gateway.dispatch(
    { id: "1", method: "push.register", deviceToken: "ab".repeat(32), topic: "ai.aegis.companion.dev", environment: "development" },
    "phone",
  );
  assert.deepEqual(registered, { type: "response", id: "1", result: { ok: true } });
  assert.deepEqual(journal.state.devices.find((d) => d.peerId === "phone").push, {
    deviceToken: "ab".repeat(32),
    topic: "ai.aegis.companion.dev",
    environment: "development",
  });
  assert.equal(journal.state.devices.find((d) => d.peerId === "old-phone").push, undefined);
  assert.equal(
    (await gateway.dispatch({ id: "2", method: "push.register", deviceToken: "nope", topic: "ai.aegis.companion", environment: "production" }, "phone")).error,
    "INVALID_REQUEST",
  );

  // A run ending in a shared project notifies once; the same event again within a minute doesn't.
  gateway.capture({ type: "session.status", payload: { sessionId: "shared", status: "running" } });
  gateway.capture({ type: "session.status", payload: { sessionId: "shared", status: "completed" } });
  await settle();
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].url, `http://127.0.0.1:${port}/v1/push`);
  assert.equal(pushes[0].body.kind, "finished");
  assert.equal(pushes[0].body.sessionId, "shared");
  assert.equal(pushes[0].body.topic, "ai.aegis.companion.dev");
  assert.match(pushes[0].signature, /^[A-Za-z0-9+/]+=*$/);
  gateway.capture({ type: "session.status", payload: { sessionId: "shared", status: "running" } });
  gateway.capture({ type: "session.status", payload: { sessionId: "shared", status: "completed" } });
  await settle();
  assert.equal(pushes.length, 1);
  // Failures and approvals have their own kinds.
  gateway.capture({ type: "session.status", payload: { sessionId: "shared", status: "running" } });
  gateway.capture({ type: "session.status", payload: { sessionId: "shared", status: "error" } });
  gateway.capture({ type: "permission.request", payload: { sessionId: "shared", toolUseId: "t", toolName: "Bash", input: {} } });
  await settle();
  assert.deepEqual(pushes.map((p) => p.body.kind), ["finished", "failed", "approval"]);
  // While a phone is connected and on screen it sees events live, so nothing is pushed.
  gateway.activePeer = "phone";
  gateway.status = "connected";
  gateway.notified.clear();
  gateway.capture({ type: "permission.request", payload: { sessionId: "shared", toolUseId: "u", toolName: "Bash", input: {} } });
  await settle();
  assert.equal(pushes.length, 3);
  // Switched away or locked: still connected for a moment, but it needs the push.
  assert.deepEqual((await gateway.dispatch({ id: "p1", method: "presence", background: true }, "phone")).result, { ok: true });
  gateway.notified.clear();
  gateway.capture({ type: "permission.request", payload: { sessionId: "shared", toolUseId: "w", toolName: "Bash", input: {} } });
  await settle();
  assert.equal(pushes.length, 4);
  await gateway.dispatch({ id: "p2", method: "presence", background: false }, "phone");
  gateway.notified.clear();
  gateway.capture({ type: "permission.request", payload: { sessionId: "shared", toolUseId: "x", toolName: "Bash", input: {} } });
  await settle();
  assert.equal(pushes.length, 4);
  gateway.activePeer = undefined;
  gateway.status = "waiting";

  // The relay reporting an unregistered token makes the Mac forget it.
  globalThis.fetch = async () => new Response(JSON.stringify({ unregistered: true }), { status: 200 });
  gateway.notified.clear();
  gateway.capture({ type: "permission.request", payload: { sessionId: "shared", toolUseId: "v", toolName: "Bash", input: {} } });
  await settle();
  assert.equal(journal.state.devices.find((d) => d.peerId === "phone").push, undefined);
  console.log("Gateway push: key-derived room migration, push registration, notify triggers, live-phone suppression, off-screen presence and unregistered tokens passed");
} finally {
  globalThis.fetch = realFetch;
  gateway.close();
  await relay.close();
  rmSync(dir, { recursive: true, force: true });
}

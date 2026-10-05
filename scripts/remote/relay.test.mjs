// Relay v2: host key proofs, room ownership, limits, and the push gateway.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { WebSocket } from "ws";
import { createRelay } from "../../services/relay/server.mjs";
import { createApns } from "../../services/relay/apns.mjs";
import { hostAuth, hostRoom } from "./relay-host.mjs";
const require = createRequire(import.meta.url);
const { createIdentity } = require("../../dist-electron/electron/remote/secure-channel.cjs");
const { identityKeys, pushRequest } = require("../../dist-electron/electron/remote/relay-auth.js");

const open = (port) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
/** Resolves with the first relay text message or the close code/reason. */
const next = (ws, type) =>
  new Promise((resolve) => {
    const onMessage = (data, binary) => {
      if (binary) return;
      const message = JSON.parse(data.toString());
      if (type && message.type !== type) return;
      ws.off("message", onMessage);
      resolve(message);
    };
    ws.on("message", onMessage);
    ws.once("close", (code, reason) => resolve({ closed: code, reason: reason.toString() }));
  });
const token = () => randomBytes(32).toString("hex");

async function withRelay(options, run) {
  const relay = createRelay({ port: 0, ...options });
  const { port } = await relay.listen();
  try {
    await run(port, relay);
  } finally {
    await relay.close();
  }
}

// Open registration: a key proof alone registers the room derived from the key.
await withRelay({}, async (port, relay) => {
  const id = await createIdentity();
  const ws = await open(port);
  const registered = next(ws, "registered");
  const room = hostAuth(ws, id.privateKey, { token: token() });
  assert.equal((await registered).type, "registered");
  assert.equal(relay.rooms.get(room).publicKey, identityKeys(id.privateKey).publicKey);
  ws.close();
});

// A wrong signature, a room that isn't the key's, and a missing token on a gated relay are refused.
await withRelay({}, async (port) => {
  const id = await createIdentity();
  const other = await createIdentity();
  const keys = identityKeys(id.privateKey);
  const room = hostRoom(id.privateKey);

  let ws = await open(port);
  ws.send(JSON.stringify({ role: "host", room, publicKey: keys.publicKey, token: token() }));
  const challenge = await next(ws, "challenge");
  assert.match(challenge.nonce, /^[a-f0-9]{64}$/);
  const wrongSig = identityKeys(other.privateKey).sign(Buffer.from("not the challenge"));
  ws.send(JSON.stringify({ type: "proof", signature: wrongSig.toString("base64") }));
  assert.deepEqual(await next(ws), { closed: 1008, reason: "bad-signature" });

  ws = await open(port);
  ws.send(JSON.stringify({ role: "host", room: hostRoom(other.privateKey), publicKey: keys.publicKey, token: token() }));
  assert.deepEqual(await next(ws), { closed: 1008, reason: "room-mismatch" });
});
await withRelay({ registrationToken: token() }, async (port) => {
  const id = await createIdentity();
  const ws = await open(port);
  const result = next(ws);
  hostAuth(ws, id.privateKey, { token: token() });
  assert.equal((await result).closed, 1008);
});
{
  const gate = token();
  await withRelay({ registrationToken: gate }, async (port) => {
    const id = await createIdentity();
    const ws = await open(port);
    const registered = next(ws, "registered");
    hostAuth(ws, id.privateKey, { token: token(), registrationToken: gate });
    assert.equal((await registered).type, "registered");
    ws.close();
  });
}

// The same key reconnecting replaces its stale tunnel; phones then reach the new host.
await withRelay({}, async (port) => {
  const id = await createIdentity();
  const route = token();
  const first = await open(port);
  const firstRegistered = next(first, "registered");
  hostAuth(first, id.privateKey, { token: route });
  await firstRegistered;
  const firstClosed = next(first, "never");
  const second = await open(port);
  const secondRegistered = next(second, "registered");
  const room = hostAuth(second, id.privateKey, { token: route });
  await secondRegistered;
  assert.deepEqual(await firstClosed, { closed: 1012, reason: "Replaced" });
  const phone = await open(port);
  const peer = next(phone, "peer");
  phone.send(JSON.stringify({ role: "phone", room, token: route }));
  assert.equal((await peer).type, "peer");
  phone.close();
  second.close();
});

// Per-IP connection cap.
await withRelay({ maxPerIp: 2 }, async (port) => {
  const a = await open(port);
  const b = await open(port);
  const c = await open(port);
  assert.deepEqual(await next(c), { closed: 1008, reason: "rate-limited" });
  a.close();
  b.close();
});

// Push gateway.
const sent = [];
const fakeApns = {
  send: async (request) => {
    sent.push(request);
    return request.deviceToken.startsWith("dead") ? { unregistered: true } : { ok: true };
  },
};
const fields = {
  deviceToken: "ab".repeat(32),
  topic: "ai.aegis.companion",
  environment: "production",
  kind: "approval",
  sessionId: "session-1",
  machineName: "Test Mac",
};
const post = async (port, { body, signature }) => {
  const res = await fetch(`http://127.0.0.1:${port}/v1/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Aegis-Signature": signature },
    body,
  });
  return { status: res.status, json: await res.json() };
};
await withRelay({ apns: fakeApns, pushesPerHour: 3 }, async (port) => {
  const id = await createIdentity();
  // Offline hosts can't push.
  assert.equal((await post(port, pushRequest(id.privateKey, fields))).status, 403);
  const ws = await open(port);
  const registered = next(ws, "registered");
  hostAuth(ws, id.privateKey, { token: token() });
  await registered;

  const signed = pushRequest(id.privateKey, fields);
  assert.deepEqual(await post(port, signed), { status: 200, json: { ok: true } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].collapseId, "approval:session-1");
  assert.deepEqual(sent[0].payload, {
    aps: { alert: { title: "Test Mac", body: "A task needs your approval" }, sound: "default", "thread-id": "session-1" },
    sessionId: "session-1",
  });
  // Replayed nonce, tampered body, someone else's key, bad topic.
  assert.equal((await post(port, signed)).status, 401);
  assert.equal((await post(port, { ...signed, body: signed.body.replace("approval", "finished") })).status, 401);
  const stranger = await createIdentity();
  assert.equal((await post(port, pushRequest(stranger.privateKey, fields))).status, 403);
  assert.equal((await post(port, pushRequest(id.privateKey, { ...fields, topic: "com.example" }))).status, 400);
  // Unregistered tokens are reported back so the Mac can forget them.
  assert.deepEqual(await post(port, pushRequest(id.privateKey, { ...fields, deviceToken: "dead" + "0".repeat(60) })), {
    status: 200,
    json: { unregistered: true },
  });
  // Third accepted push used up the hourly budget of 3.
  await post(port, pushRequest(id.privateKey, fields));
  assert.equal((await post(port, pushRequest(id.privateKey, fields))).status, 429);
  ws.close();
});
await withRelay({}, async (port) => {
  const id = await createIdentity();
  const ws = await open(port);
  const registered = next(ws, "registered");
  hostAuth(ws, id.privateKey, { token: token() });
  await registered;
  assert.equal((await post(port, pushRequest(id.privateKey, fields))).status, 503);
  ws.close();
});

// APNs sender: ES256 provider token, headers, and error mapping.
{
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const requests = [];
  let status = 200;
  let clock = 1_800_000_000_000;
  const apns = createApns({
    key: privateKey.export({ type: "pkcs8", format: "pem" }),
    keyId: "KEY1234567",
    teamId: "TEAM123456",
    now: () => clock,
    transport: {
      request: async (origin, headers, body) => {
        requests.push({ origin, headers, body });
        return status === 200 ? { status } : { status, body: JSON.stringify({ reason: status === 410 ? "Unregistered" : "TooManyRequests" }) };
      },
    },
  });
  const message = { deviceToken: "cd".repeat(32), topic: "ai.aegis.companion.dev", environment: "development", payload: { aps: {} }, collapseId: "x" };
  assert.deepEqual(await apns.send(message), { ok: true });
  const [{ origin, headers }] = requests;
  assert.equal(origin, "https://api.sandbox.push.apple.com");
  assert.equal(headers[":path"], `/3/device/${"cd".repeat(32)}`);
  assert.equal(headers["apns-topic"], "ai.aegis.companion.dev");
  assert.equal(headers["apns-push-type"], "alert");
  const [h, c, s] = headers.authorization.slice("bearer ".length).split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { alg: "ES256", kid: "KEY1234567" });
  assert.deepEqual(JSON.parse(Buffer.from(c, "base64url")), { iss: "TEAM123456", iat: clock / 1000 });
  assert(verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")));
  // The token is reused within its lifetime and refreshed after.
  clock += 10 * 60000;
  await apns.send(message);
  assert.equal(requests[1].headers.authorization, headers.authorization);
  clock += 50 * 60000;
  await apns.send({ ...message, environment: "production" });
  assert.notEqual(requests[2].headers.authorization, headers.authorization);
  assert.equal(requests[2].origin, "https://api.push.apple.com");
  status = 410;
  assert.deepEqual(await apns.send(message), { unregistered: true });
  status = 429;
  assert.deepEqual(await apns.send(message), { error: "TooManyRequests" });
  assert.equal(createApns({}), null);
}

console.log("Relay: host key proofs, room ownership, token gate, tunnel replacement, IP cap, push gateway and APNs sender passed");

import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { pathToFileURL } from "node:url";
import { createApns } from "./apns.mjs";
import { hostProof, pushProof, roomFor, verifyEd25519 } from "./protocol.mjs";

const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const HEX64 = /^[a-f0-9]{64}$/;
const PUSH_TEXT = {
  approval: "A task needs your approval",
  finished: "A task finished",
  failed: "A task failed",
};

/** Fixed-window counter keyed by IP or host key. */
function limiter(limit, windowMs) {
  const hits = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (now - entry.at >= windowMs) hits.delete(key);
  }, windowMs);
  sweep.unref();
  return (key) => {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.at >= windowMs) {
      hits.set(key, { at: now, count: 1 });
      return true;
    }
    entry.count++;
    return entry.count <= limit;
  };
}

/**
 * Hosts prove they own their room with an Ed25519 signature over a challenge;
 * `registrationToken` additionally gates hosts on a self-hosted relay.
 */
export function createRelay({
  host = "127.0.0.1",
  port = 8788,
  registrationToken,
  maxRooms = 2000,
  maxPerIp = 20,
  authsPerMinute = 30,
  pushesPerHour = 120,
  trustProxy = false,
  apns = null,
  /** Bundle ids allowed as APNs topics. */
  topics = ["ai.aegis.companion", "ai.aegis.companion.dev"],
} = {}) {
  const TOPICS = new Set(topics);
  if (registrationToken !== undefined && (typeof registrationToken !== "string" || registrationToken.length < 32))
    throw new Error("A relay registration token must be at least 32 characters");
  const rooms = new Map();
  const perIp = new Map();
  const authLimit = limiter(authsPerMinute, 60000);
  const pushLimit = limiter(pushesPerHour, 3600000);
  const pushIpLimit = limiter(60, 60000);
  const nonces = new Map();
  const clientIp = (req) =>
    (trustProxy && String(req.headers["fly-client-ip"] || "")) || req.socket.remoteAddress || "";
  const json = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  async function push(req, res) {
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 4096) return json(res, 413, { error: "too-large" });
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(res, 400, { error: "invalid" });
    }
    const signature = Buffer.from(String(req.headers["x-aegis-signature"] || ""), "base64");
    const now = Date.now();
    if (
      !HEX64.test(body.publicKey ?? "") ||
      typeof body.ts !== "number" ||
      !/^[a-f0-9]{32}$/.test(body.nonce ?? "") ||
      !/^[a-f0-9]{64,200}$/.test(body.deviceToken ?? "") ||
      !TOPICS.has(body.topic) ||
      !["development", "production"].includes(body.environment) ||
      !PUSH_TEXT[body.kind] ||
      (body.sessionId !== undefined && (typeof body.sessionId !== "string" || body.sessionId.length > 128)) ||
      (body.machineName !== undefined && (typeof body.machineName !== "string" || body.machineName.length > 100))
    )
      return json(res, 400, { error: "invalid" });
    const publicKey = Buffer.from(body.publicKey, "hex");
    if (Math.abs(now - body.ts) > 5 * 60000 || nonces.has(body.nonce) || !verifyEd25519(publicKey, pushProof(raw), signature))
      return json(res, 401, { error: "bad-signature" });
    nonces.set(body.nonce, now + 10 * 60000);
    for (const [nonce, expires] of nonces) if (expires < now) nonces.delete(nonce);
    // Only a Mac that is connected to this relay right now may notify its phones.
    if (rooms.get(roomFor(publicKey))?.publicKey !== body.publicKey) return json(res, 403, { error: "host-offline" });
    if (!pushLimit(body.publicKey)) return json(res, 429, { error: "rate-limited" });
    if (!apns) return json(res, 503, { error: "push-unavailable" });
    try {
      const result = await apns.send({
        deviceToken: body.deviceToken,
        topic: body.topic,
        environment: body.environment,
        collapseId: body.sessionId ? `${body.kind}:${body.sessionId}` : undefined,
        payload: {
          aps: {
            alert: { title: body.machineName || "Aegis", body: PUSH_TEXT[body.kind] },
            sound: "default",
            ...(body.sessionId ? { "thread-id": body.sessionId } : {}),
          },
          ...(body.sessionId ? { sessionId: body.sessionId } : {}),
        },
      });
      if (result.ok) return json(res, 200, { ok: true });
      if (result.unregistered) return json(res, 200, { unregistered: true });
      return json(res, 502, { error: "apns", reason: result.error });
    } catch {
      return json(res, 502, { error: "apns" });
    }
  }

  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("ok");
    }
    if (req.url === "/v1/push" && req.method === "POST") {
      if (!pushIpLimit(clientIp(req))) return json(res, 429, { error: "rate-limited" });
      return void push(req, res).catch(() => json(res, 400, { error: "invalid" }));
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("");
  });
  const wss = new WebSocketServer({
    server,
    maxPayload: 256 * 1024,
    perMessageDeflate: false,
  });
  const alive = new WeakSet();
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!alive.has(socket)) {
        socket.terminate();
        continue;
      }
      alive.delete(socket);
      socket.ping();
    }
  }, 20000);
  heartbeat.unref();
  wss.on("connection", (socket, req) => {
    const ip = clientIp(req);
    if (wss.clients.size > maxRooms * 3) {
      socket.terminate();
      return;
    }
    if ((perIp.get(ip) ?? 0) >= maxPerIp || !authLimit(ip)) {
      socket.close(1008, "rate-limited");
      return;
    }
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    alive.add(socket);
    socket.on("pong", () => alive.add(socket));
    let authenticated = false,
      room,
      role,
      pending;
    const timer = setTimeout(
      () => socket.close(1008, "Authentication required"),
      5000,
    );
    const reject = (reason) => socket.close(1008, reason);
    const register = () => {
      const previous = rooms.get(pending.room);
      if (previous) {
        // The same Mac reconnected (its key proved it); the old tunnel is stale.
        previous.replaced = true;
        previous.phone?.close(1012, "Host disconnected");
        previous.host.close(1012, "Replaced");
      } else if (rooms.size >= maxRooms) return reject("Relay is full");
      room = { host: socket, phone: null, token: pending.token, id: pending.room, publicKey: pending.publicKey };
      rooms.set(room.id, room);
      role = "host";
      authenticated = true;
      clearTimeout(timer);
      socket.send(JSON.stringify({ type: "registered" }));
    };
    socket.on("message", (data, binary) => {
      if (!authenticated) {
        let auth;
        try {
          if (binary || data.length > 4096) throw new Error();
          auth = JSON.parse(data.toString());
        } catch {
          return reject("Connection rejected");
        }
        if (pending) {
          // Second host message: the signed challenge.
          const signature = Buffer.from(typeof auth.signature === "string" ? auth.signature : "", "base64");
          if (auth.type !== "proof" || !verifyEd25519(Buffer.from(pending.publicKey, "hex"), hostProof(pending.nonce, pending.room), signature))
            return reject("bad-signature");
          return register();
        }
        if (
          !/^[a-f0-9]{32}$/.test(auth.room) ||
          !["host", "phone"].includes(auth.role) ||
          typeof auth.token !== "string" ||
          auth.token.length < 32 ||
          auth.token.length > 128
        )
          return reject("Connection rejected");
        if (auth.role === "host") {
          if (registrationToken !== undefined && !equal(auth.registrationToken, registrationToken))
            return reject("Connection rejected");
          if (!HEX64.test(auth.publicKey ?? "")) return reject("Connection rejected");
          if (roomFor(Buffer.from(auth.publicKey, "hex")) !== auth.room) return reject("room-mismatch");
          pending = { room: auth.room, token: auth.token, publicKey: auth.publicKey, nonce: randomBytes(32).toString("hex") };
          socket.send(JSON.stringify({ type: "challenge", nonce: pending.nonce }));
          return;
        }
        room = rooms.get(auth.room);
        if (!room || !equal(room.token, auth.token) || room.phone) return reject("Connection rejected");
        role = "phone";
        room.phone = socket;
        room.host.send(JSON.stringify({ type: "peer" }));
        socket.send(JSON.stringify({ type: "peer" }));
        authenticated = true;
        clearTimeout(timer);
        return;
      }
      const target = role === "host" ? room?.phone : room?.host;
      if (
        !binary ||
        !target ||
        target.readyState !== WebSocket.OPEN ||
        target.bufferedAmount > 4 * 1024 * 1024
      ) {
        socket.close(1008, "Invalid tunnel frame");
        return;
      }
      target.send(data, { binary: true });
    });
    socket.on("error", () => socket.terminate());
    socket.on("close", () => {
      clearTimeout(timer);
      const left = (perIp.get(ip) ?? 1) - 1;
      if (left > 0) perIp.set(ip, left);
      else perIp.delete(ip);
      if (role === "host" && room?.host === socket) {
        if (rooms.get(room.id) === room) rooms.delete(room.id);
        if (!room.replaced) room.phone?.close(1012, "Host disconnected");
      }
      if (role === "phone" && room?.phone === socket) {
        room.phone = null;
        if (!room.replaced) room.host.close(1012, "Recreate encrypted connection");
      }
    });
  });
  return {
    server,
    rooms,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          resolve(server.address());
        });
      }),
    close: () =>
      new Promise((resolve) => {
        clearInterval(heartbeat);
        for (const s of wss.clients) s.terminate();
        apns?.close?.();
        wss.close(() => server.close(resolve));
      }),
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const relay = createRelay({
    host: process.env.RELAY_BIND || "127.0.0.1",
    port: Number(process.env.PORT || 8788),
    registrationToken: process.env.RELAY_REGISTRATION_TOKEN || undefined,
    trustProxy: process.env.RELAY_TRUST_PROXY === "1",
    ...(process.env.APNS_TOPICS ? { topics: process.env.APNS_TOPICS.split(",").map((t) => t.trim()).filter(Boolean) } : {}),
    apns: createApns({
      key: process.env.APNS_KEY,
      keyId: process.env.APNS_KEY_ID,
      teamId: process.env.APNS_TEAM_ID,
    }),
  });
  await relay.listen();
  console.log(
    `Aegis relay listening (${process.env.RELAY_REGISTRATION_TOKEN ? "registration token required" : "open host registration"}; push ${process.env.APNS_KEY ? "on" : "off"}; TLS termination required outside loopback)`,
  );
}

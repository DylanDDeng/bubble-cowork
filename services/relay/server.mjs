import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { pathToFileURL } from "node:url";

const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function createRelay({
  host = "127.0.0.1",
  port = 8788,
  registrationToken,
  maxRooms = 100,
} = {}) {
  if (!registrationToken || registrationToken.length < 32)
    throw new Error(
      "A relay registration token of at least 32 characters is required",
    );
  const rooms = new Map();
  const server = createServer((req, res) => {
    res.writeHead(req.url === "/health" ? 200 : 404, {
      "Content-Type": "text/plain",
    });
    res.end(req.url === "/health" ? "ok" : "");
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
  wss.on("connection", (socket) => {
    if (wss.clients.size > maxRooms * 3) {
      socket.terminate();
      return;
    }
    alive.add(socket);
    socket.on("pong", () => alive.add(socket));
    let authenticated = false,
      room,
      role;
    const timer = setTimeout(
      () => socket.close(1008, "Authentication required"),
      5000,
    );
    socket.on("message", (data, binary) => {
      if (!authenticated) {
        try {
          if (binary || data.length > 4096) throw new Error();
          const auth = JSON.parse(data.toString());
          if (
            !/^[a-f0-9]{32}$/.test(auth.room) ||
            !["host", "phone"].includes(auth.role) ||
            typeof auth.token !== "string" ||
            auth.token.length < 32 ||
            auth.token.length > 128
          )
            throw new Error();
          role = auth.role;
          if (role === "host") {
            if (
              !equal(auth.registrationToken, registrationToken) ||
              rooms.has(auth.room) ||
              rooms.size >= maxRooms
            )
              throw new Error();
            room = {
              host: socket,
              phone: null,
              token: auth.token,
              id: auth.room,
            };
            rooms.set(auth.room, room);
            socket.send(JSON.stringify({ type: "registered" }));
          } else {
            room = rooms.get(auth.room);
            if (!room || !equal(room.token, auth.token) || room.phone)
              throw new Error();
            room.phone = socket;
            room.host.send(JSON.stringify({ type: "peer" }));
            socket.send(JSON.stringify({ type: "peer" }));
          }
          authenticated = true;
          clearTimeout(timer);
        } catch {
          socket.close(1008, "Connection rejected");
        }
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
      if (role === "host" && room?.host === socket) {
        if (rooms.get(room.id) === room) rooms.delete(room.id);
        room.phone?.close(1012, "Host disconnected");
      }
      if (role === "phone" && room?.phone === socket) {
        room.phone = null;
        room.host.close(1012, "Recreate encrypted connection");
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
    registrationToken: process.env.RELAY_REGISTRATION_TOKEN,
  });
  await relay.listen();
  console.log(
    "Aegis relay listening (TLS termination required outside loopback)",
  );
}

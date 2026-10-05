import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { createRelay } from "../../services/relay/server.mjs";
const { createIdentity, secureChannel } = createRequire(import.meta.url)(
  "../../dist-electron/electron/remote/secure-channel.cjs",
);
const token = randomBytes(32).toString("hex");
const relay = createRelay({ port: 0, registrationToken: token });
const address = await relay.listen();
const hostIdentity = await createIdentity(),
  phoneIdentity = await createIdentity();
const room = randomBytes(16).toString("hex");
function connect(role) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
    ws.binaryType = "arraybuffer";
    ws.on("open", () =>
      ws.send(JSON.stringify({ role, room, token, registrationToken: token })),
    );
    const listener = (event) => {
      if (
        typeof event.data === "string" &&
        JSON.parse(event.data).type === "peer"
      ) {
        ws.removeEventListener("message", listener);
        resolve(ws);
      }
    };
    ws.addEventListener("message", listener);
    ws.on("error", reject);
  });
}
let host, phone;
try {
  const hp = connect("host").then((s) =>
    secureChannel(s, hostIdentity.privateKey, false),
  );
  await new Promise((r) => setTimeout(r, 100));
  const pp = connect("phone").then((s) =>
    secureChannel(s, phoneIdentity.privateKey, true, hostIdentity.peerId),
  );
  [host, phone] = await Promise.all([hp, pp]);
  phone.send({ test: "加密测试", long: "x".repeat(150000) });
  const value = await host.messages.next();
  assert.equal(value.value.test, "加密测试");
  assert.equal(value.value.long.length, 150000);
  host.send({ ok: true });
  assert.deepEqual((await phone.messages.next()).value, { ok: true });
  assert.equal(host.peerId, phoneIdentity.peerId);
  console.log(
    "Noise XX: pinned identities, bidirectional Unicode and chunked payload passed",
  );
} finally {
  host?.close();
  phone?.close();
  await relay.close();
}

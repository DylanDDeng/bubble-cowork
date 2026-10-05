import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { createRelay } from "../../services/relay/server.mjs";
const { createIdentity, secureChannel } = createRequire(import.meta.url)(
  "../../dist-electron/electron/remote/secure-channel.cjs",
);
async function setup(wrongPin = false) {
  const token = randomBytes(32).toString("hex"),
    room = randomBytes(16).toString("hex");
  const relay = createRelay({ port: 0, registrationToken: token });
  const address = await relay.listen();
  const hi = await createIdentity(),
    pi = await createIdentity(),
    wrong = await createIdentity();
  let hostSocket, phoneSocket;
  const connect = (role) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
      ws.binaryType = "arraybuffer";
      if (role === "host") hostSocket = ws;
      else phoneSocket = ws;
      ws.on("error", reject);
      ws.on("open", () =>
        ws.send(
          JSON.stringify({ role, room, token, registrationToken: token }),
        ),
      );
      const onmessage = (event) => {
        if (
          typeof event.data === "string" &&
          JSON.parse(event.data).type === "peer"
        ) {
          ws.removeEventListener("message", onmessage);
          resolve(ws);
        }
      };
      ws.addEventListener("message", onmessage);
    });
  const hp = connect("host").then((ws) =>
    secureChannel(ws, hi.privateKey, false),
  );
  // Attach rejection handlers before starting the peer, including failed handshakes.
  const h = hp.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await new Promise((r) => setTimeout(r, 20));
  const p = connect("phone")
    .then((ws) =>
      secureChannel(
        ws,
        pi.privateKey,
        true,
        wrongPin ? wrong.peerId : hi.peerId,
      ),
    )
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  const [host, phone] = await Promise.all([h, p]);
  return {
    host,
    phone,
    phoneSocket,
    close: async () => {
      host.value?.close();
      phone.value?.close();
      hostSocket?.close();
      phoneSocket?.close();
      await relay.close();
    },
  };
}
{
  const pair = await setup(true);
  try {
    assert(pair.phone.error, "Wrong pinned identity must fail");
  } finally {
    await pair.close();
  }
}
for (const attack of ["tamper", "replay"]) {
  const pair = await setup();
  try {
    const original = pair.phoneSocket.send.bind(pair.phoneSocket);
    pair.phoneSocket.send = (data) => {
      const frame = Buffer.from(data);
      if (attack === "tamper") {
        frame[frame.length - 1] ^= 1;
        original(frame);
      } else {
        original(frame);
        original(frame);
      }
    };
    const received = (async () => {
      const values = [];
      try {
        for await (const value of pair.host.value.messages) values.push(value);
      } catch {
        return { values, rejected: true };
      }
      return { values, rejected: false };
    })();
    pair.phone.value.send({ test: attack });
    const result = await received;
    assert.equal(result.rejected, true);
    assert.equal(result.values.length, attack === "tamper" ? 0 : 1);
  } finally {
    await pair.close();
  }
}
console.log(
  "Noise negative tests: wrong pinned identity, ciphertext tampering and replay rejected",
);

// Interop peer for AegisKitTests: runs the desktop's real secure channel
// (dist-electron/electron/remote/secure-channel.cjs, built by build-crypto.mjs)
// behind a WebSocket server and echoes every application message.
//   node noise-peer.mjs responder   → Swift connects as the Noise initiator
//   node noise-peer.mjs initiator   → Node is the initiator (pins the Swift peer id from stdin)
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const root = join(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const require = createRequire(join(root, "package.json"));
const { WebSocketServer } = require("ws");
const { createIdentity, secureChannel } = require(join(root, "dist-electron/electron/remote/secure-channel.cjs"));

const role = process.argv[2] || "responder";
const identity = await createIdentity();
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await new Promise((r) => server.once("listening", r));
console.log(JSON.stringify({ port: server.address().port, peerId: identity.peerId }));

const expected = role === "initiator" ? (await new Promise((r) => process.stdin.once("data", (d) => r(String(d).trim())))) : undefined;

server.on("connection", async (socket) => {
  socket.binaryType = "arraybuffer";
  try {
    const channel = await secureChannel(socket, identity.privateKey, role === "initiator", expected);
    console.log(JSON.stringify({ remote: channel.peerId }));
    for await (const message of channel.messages) {
      channel.send({ echo: message });
      if (message?.type === "bye") break;
    }
  } catch (error) {
    console.log(JSON.stringify({ error: String(error?.message || error) }));
  }
});
setTimeout(() => process.exit(0), 30000).unref();

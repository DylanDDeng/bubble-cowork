// Test helper: the host side of the relay handshake, using the desktop's own proof code.
import { createRequire } from "node:module";
const { identityKeys, roomFor, hostProof } = createRequire(import.meta.url)(
  "../../dist-electron/electron/remote/relay-auth.js",
);

export const hostRoom = (identity) => roomFor(identityKeys(identity).publicKey);

/** Sends the host hello on an open socket and answers the relay's challenge. */
export function hostAuth(ws, identity, fields) {
  const keys = identityKeys(identity);
  const room = roomFor(keys.publicKey);
  const onChallenge = (event) => {
    if (typeof event.data !== "string") return;
    const message = JSON.parse(event.data);
    if (message.type !== "challenge") return;
    ws.removeEventListener("message", onChallenge);
    ws.send(JSON.stringify({ type: "proof", signature: keys.sign(hostProof(message.nonce, room)).toString("base64") }));
  };
  ws.addEventListener("message", onChallenge);
  ws.send(JSON.stringify({ role: "host", room, publicKey: keys.publicKey, ...fields }));
  return room;
}

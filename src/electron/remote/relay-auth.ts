// Host-side proofs for the relay. Mirrors services/relay/protocol.mjs.
import { createHash, createPrivateKey, randomBytes, sign } from "crypto";

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

/** The public relay; AEGIS_REMOTE_RELAY overrides it (e.g. a local relay). */
export const DEFAULT_RELAY = "wss://aegis-relay.fly.dev/";
export const defaultRelay = () => process.env.AEGIS_REMOTE_RELAY || DEFAULT_RELAY;

/** Splits the stored libp2p Ed25519 identity (protobuf: 08 01 12 40 seed‖pub). */
export function identityKeys(identity: string) {
  const bytes = Buffer.from(identity, "base64");
  if (bytes.length !== 68 || bytes[0] !== 0x08 || bytes[1] !== 0x01 || bytes[2] !== 0x12 || bytes[3] !== 0x40)
    throw new Error("Unsupported identity");
  const seed = bytes.subarray(4, 36);
  return {
    publicKey: bytes.subarray(36, 68).toString("hex"),
    sign: (message: Buffer) =>
      sign(null, message, createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" })),
  };
}

export function roomFor(publicKeyHex: string) {
  return createHash("sha256")
    .update("aegis.relay.room/1")
    .update(Buffer.from(publicKeyHex, "hex"))
    .digest("hex")
    .slice(0, 32);
}

export function hostProof(nonce: string, room: string) {
  return Buffer.concat([Buffer.from("aegis.relay.host/1"), Buffer.from(nonce, "hex"), Buffer.from(room)]);
}

/** A signed push request for the relay's /v1/push. */
export function pushRequest(
  identity: string,
  fields: {
    deviceToken: string;
    topic: string;
    environment: "development" | "production";
    kind: "approval" | "finished" | "failed";
    sessionId?: string;
    machineName?: string;
  },
) {
  const keys = identityKeys(identity);
  const body = JSON.stringify({
    publicKey: keys.publicKey,
    ts: Date.now(),
    nonce: randomBytes(16).toString("hex"),
    ...fields,
  });
  const signature = keys.sign(Buffer.concat([Buffer.from("aegis.relay.push/1"), Buffer.from(body)]));
  return { body, signature: signature.toString("base64") };
}

/** https origin of a ws(s) relay URL, for its HTTP endpoints. */
export const relayHttpOrigin = (relay: string) => {
  const url = new URL(relay);
  url.protocol = url.protocol === "ws:" ? "http:" : "https:";
  return url.origin;
};

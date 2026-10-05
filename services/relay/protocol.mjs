// Host proofs shared by the relay and its tests. The desktop mirrors these in
// src/electron/remote/relay-auth.ts; keep both in sync.
import { createHash, createPublicKey, verify } from "node:crypto";

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

/** A host's room is derived from its Ed25519 key, so nobody else can claim it. */
export function roomFor(publicKey) {
  return createHash("sha256")
    .update("aegis.relay.room/1")
    .update(publicKey)
    .digest("hex")
    .slice(0, 32);
}

/** Bytes a host signs to answer the relay's challenge for `room`. */
export function hostProof(nonce, room) {
  return Buffer.concat([
    Buffer.from("aegis.relay.host/1"),
    Buffer.from(nonce, "hex"),
    Buffer.from(room),
  ]);
}

/** Bytes a host signs to send a push: the exact request body. */
export function pushProof(body) {
  return Buffer.concat([Buffer.from("aegis.relay.push/1"), Buffer.from(body)]);
}

export function verifyEd25519(publicKey, message, signature) {
  try {
    if (publicKey.length !== 32 || signature.length !== 64) return false;
    const key = createPublicKey({
      key: Buffer.concat([SPKI_ED25519, publicKey]),
      format: "der",
      type: "spki",
    });
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}

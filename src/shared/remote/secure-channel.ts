// Noise XX is implemented by ChainSafe; this module only adapts streams and frames JSON.
import { noise, pureJsCrypto } from "@chainsafe/libp2p-noise";
import {
  generateKeyPair,
  privateKeyFromProtobuf,
  privateKeyToProtobuf,
} from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey, peerIdFromString } from "@libp2p/peer-id";
import { defaultLogger } from "@libp2p/logger";
import { pushable } from "it-pushable";

const MAX_FRAME = 2 * 1024 * 1024;
const PROLOGUE = new TextEncoder().encode("aegis.remote.v1/noise-xx/1");
export function encodeKey(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (x) => String.fromCharCode(x)).join(""));
}
export function decodeKey(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
export async function createIdentity() {
  const key = await generateKeyPair("Ed25519");
  return {
    privateKey: encodeKey(privateKeyToProtobuf(key)),
    peerId: peerIdFromPrivateKey(key).toString(),
  };
}
export interface WireSocket {
  send(data: Uint8Array): void;
  close(): void;
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
}
export async function secureChannel(
  socket: WireSocket,
  identity: string,
  initiator: boolean,
  expectedPeer?: string,
) {
  const input = pushable<Uint8Array>();
  const output = pushable<Uint8Array>();
  const messages = pushable<unknown>({ objectMode: true });
  let closed = false;
  let buffered = 0;
  const fail = (error?: Error) => {
    if (closed) return;
    closed = true;
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("close", onClose);
    socket.removeEventListener("error", onError);
    input.end(error);
    output.end(error);
    messages.end(error);
    socket.close();
  };
  const onMessage = (event: { data: any }) => {
    // Relay control frames are not application data and never enter Noise.
    if (typeof event.data === "string") {
      fail(new Error("Unexpected relay control"));
      return;
    }
    const bytes =
      event.data instanceof ArrayBuffer
        ? new Uint8Array(event.data)
        : new Uint8Array(
            event.data.buffer,
            event.data.byteOffset,
            event.data.byteLength,
          );
    buffered += bytes.length;
    if (buffered > MAX_FRAME * 4) {
      fail(new Error("Inbound buffer exceeded"));
      return;
    }
    input.push(bytes);
  };
  const onClose = () => fail(new Error("Connection closed"));
  const onError = () => fail(new Error("Connection failed"));
  socket.addEventListener("message", onMessage);
  socket.addEventListener("close", onClose);
  socket.addEventListener("error", onError);
  const key = privateKeyFromProtobuf(decodeKey(identity));
  const encrypter = noise({ crypto: pureJsCrypto, prologueBytes: PROLOGUE })({
    privateKey: key,
    peerId: peerIdFromPrivateKey(key),
    logger: defaultLogger(),
    upgrader: { getStreamMuxers: () => new Map() } as any,
  });
  const raw = {
    source: (async function* () {
      for await (const bytes of input) {
        buffered -= bytes.length;
        yield bytes;
      }
    })(),
    sink: async (source: AsyncIterable<any>) => {
      for await (const chunk of source) socket.send(chunk.subarray());
    },
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
    fail(new Error("Handshake timed out"));
  }, 10000);
  try {
    const secured = await (initiator
      ? encrypter.secureOutbound(raw, {
          remotePeer: expectedPeer ? peerIdFromString(expectedPeer) : undefined,
          signal: controller.signal,
        })
      : encrypter.secureInbound(raw, { signal: controller.signal }));
    clearTimeout(timeout);
    void secured.conn.sink(output).catch((error: Error) => fail(error));
    void (async () => {
      let pending = new Uint8Array(0);
      for await (const chunk of secured.conn.source) {
        const bytes = chunk.subarray();
        const joined = new Uint8Array(pending.length + bytes.length);
        joined.set(pending);
        joined.set(bytes, pending.length);
        pending = joined;
        while (pending.length >= 4) {
          const length = new DataView(
            pending.buffer,
            pending.byteOffset,
            4,
          ).getUint32(0);
          if (length > MAX_FRAME)
            throw new Error("Application frame too large");
          if (pending.length < length + 4) break;
          messages.push(
            JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(
                pending.subarray(4, length + 4),
              ),
            ),
          );
          if (messages.readableLength > 128)
            throw new Error("Application queue exceeded");
          pending = pending.slice(length + 4);
        }
      }
      fail(new Error("Encrypted stream ended"));
    })().catch(fail);
    return {
      peerId: secured.remotePeer.toString(),
      messages,
      send(value: unknown) {
        if (closed) throw new Error("Connection closed");
        const bytes = new TextEncoder().encode(JSON.stringify(value));
        if (bytes.length > MAX_FRAME || output.readableLength > 128) {
          fail(new Error("Outbound buffer exceeded"));
          throw new Error("Outbound buffer exceeded");
        }
        const frame = new Uint8Array(4 + bytes.length);
        new DataView(frame.buffer).setUint32(0, bytes.length);
        frame.set(bytes, 4);
        output.push(frame);
      },
      close: () => fail(),
    };
  } catch (error) {
    clearTimeout(timeout);
    fail();
    throw error;
  }
}

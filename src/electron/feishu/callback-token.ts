// Card button tokens: HMAC-signed, bound to the chat, the action and the
// person allowed to press it, and spendable once. Every render mints a fresh
// nonce, which also keeps the SDK's per-button click dedupe from eating a
// legitimate second press.
import { createHmac, randomBytes, timingSafeEqual } from "crypto";

export interface ButtonClaims {
  /** Action name, e.g. "stop", "perm", "project". */
  a: string;
  /** Chat the card was posted in. */
  c: string;
  /** open_ids allowed to press; empty means anyone the bridge already lets in. */
  o: string[];
  /** Expiry, ms since epoch. */
  exp: number;
  /** Action arguments. */
  d?: Record<string, unknown>;
  n?: string;
}

const b64 = (value: Buffer | string) => Buffer.from(value).toString("base64url");

export function signButton(key: string, claims: Omit<ButtonClaims, "n">): string {
  const payload = b64(JSON.stringify({ ...claims, n: randomBytes(12).toString("hex") }));
  const mac = createHmac("sha256", key).update(payload).digest();
  return `fsb1.${payload}.${b64(mac)}`;
}

export type VerifyFailure = "malformed" | "bad-signature" | "expired" | "wrong-chat" | "not-allowed" | "replayed";

/**
 * Checks a token from a card click. `spent`/`spend` back the single-use rule.
 * Returns the claims, or why the press is refused.
 */
export function verifyButton(
  key: string,
  token: unknown,
  context: { chatId: string; operator: string; owner?: string },
  spent: (nonce: string) => boolean,
): ButtonClaims | VerifyFailure {
  if (typeof token !== "string") return "malformed";
  const [version, payload, mac] = token.split(".");
  if (version !== "fsb1" || !payload || !mac) return "malformed";
  const expected = createHmac("sha256", key).update(payload).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return "bad-signature";
  let claims: ButtonClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return "malformed";
  }
  if (typeof claims.exp !== "number" || claims.exp < Date.now()) return "expired";
  if (claims.c !== context.chatId) return "wrong-chat";
  const allowed = !claims.o?.length || claims.o.includes(context.operator) || context.operator === context.owner;
  if (!allowed) return "not-allowed";
  if (!claims.n || spent(claims.n)) return "replayed";
  return claims;
}

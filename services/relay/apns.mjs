// Minimal APNs sender: token (.p8) auth over HTTP/2, no dependencies.
import { connect } from "node:http2";
import { createPrivateKey, sign } from "node:crypto";

const HOSTS = {
  development: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};
const b64url = (value) => Buffer.from(value).toString("base64url");

/** Default transport: one cached HTTP/2 session per APNs host. */
function http2Transport() {
  const sessions = new Map();
  const session = (origin) => {
    let s = sessions.get(origin);
    if (!s || s.closed || s.destroyed) {
      s = connect(origin);
      s.on("error", () => sessions.delete(origin));
      s.on("close", () => sessions.delete(origin));
      s.unref();
      sessions.set(origin, s);
    }
    return s;
  };
  return {
    request: (origin, headers, body) =>
      new Promise((resolve, reject) => {
        const req = session(origin).request(headers);
        let status = 0;
        let data = "";
        req.setEncoding("utf8");
        req.setTimeout(10000, () => req.close());
        req.on("response", (h) => (status = Number(h[":status"])));
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve({ status, body: data }));
        req.on("error", reject);
        req.end(body);
      }),
    close: () => {
      for (const s of sessions.values()) s.close();
      sessions.clear();
    },
  };
}

/** Returns null when APNs isn't configured; the relay then answers 503. */
export function createApns({ key, keyId, teamId, transport = http2Transport(), now = Date.now } = {}) {
  if (!key || !keyId || !teamId) return null;
  const privateKey = createPrivateKey(key.replace(/\\n/g, "\n"));
  let token = { value: "", at: 0 };
  const jwt = () => {
    // Apple rejects tokens older than an hour and throttles refreshes under 20 minutes.
    if (now() - token.at < 50 * 60 * 1000) return token.value;
    const iat = Math.floor(now() / 1000);
    const input = `${b64url(JSON.stringify({ alg: "ES256", kid: keyId }))}.${b64url(JSON.stringify({ iss: teamId, iat }))}`;
    const signature = sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" });
    token = { value: `${input}.${b64url(signature)}`, at: now() };
    return token.value;
  };
  return {
    /** Resolves to { ok } or { unregistered } or { error }. */
    async send({ deviceToken, topic, environment, payload, collapseId }) {
      const headers = {
        ":method": "POST",
        ":path": `/3/device/${deviceToken}`,
        authorization: `bearer ${jwt()}`,
        "apns-topic": topic,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-expiration": String(Math.floor(now() / 1000) + 3600),
        ...(collapseId ? { "apns-collapse-id": collapseId.slice(0, 64) } : {}),
      };
      const res = await transport.request(HOSTS[environment], headers, JSON.stringify(payload));
      if (res.status === 200) return { ok: true };
      let reason = "";
      try {
        reason = JSON.parse(res.body).reason ?? "";
      } catch {}
      if (res.status === 410 || reason === "BadDeviceToken" || reason === "Unregistered")
        return { unregistered: true };
      return { error: reason || `status ${res.status}` };
    },
    close: () => transport.close?.(),
  };
}

# Aegis relay

The relay connects a desktop and its phone. It forwards their end-to-end encrypted
Noise ciphertext and sends status-only push notifications through APNs. It never
parses business commands or stores chat history.

## How hosts and phones connect

- **Host (the Mac):**
  1. Opens a WebSocket and sends `{role:"host", room, token, publicKey}`. The room
     must equal `sha256("aegis.relay.room/1" ‖ publicKey)[0:16]` in hex, so a room
     belongs to one Ed25519 host key.
  2. The relay answers with a challenge nonce.
  3. The host signs `"aegis.relay.host/1" ‖ nonce ‖ room`.
  4. Once the signature checks out, the relay registers the room. If the same key
     connects again, the new connection replaces the stale one.
- **Phone:** sends `{role:"phone", room, token}` with the route token from pairing.
  The relay then splices the two sockets together.
- **Inside the tunnel:** Noise XX runs between the two ends, pinned to the host's peer
  id. Each phone also needs separate approval on the Mac.

By default anyone with a key can register a room, which is what the public relay
needs. `RELAY_REGISTRATION_TOKEN` additionally restricts hosts to people who know a
shared token, which suits a private self-hosted relay. On the desktop, set a custom
relay and token under Settings → Connections → Set up → Custom relay.

### Limits

- 20 concurrent connections per IP. Behind Fly, the IP comes from `Fly-Client-IP`
  when `RELAY_TRUST_PROXY=1`.
- 30 connection attempts per IP per minute.
- 2000 rooms.
- 256 KB per frame.

## Push

`POST /v1/push` takes `{publicKey, ts, nonce, deviceToken, topic, environment, kind, sessionId?, machineName?}`,
signed by the host key in `X-Aegis-Signature`. The signature covers
`"aegis.relay.push/1" ‖ body`.

The relay checks that:
- the timestamp is within 5 minutes;
- the nonce hasn't been used before;
- the signature is valid;
- the host is currently connected;
- the host has sent no more than 120 pushes in the past hour;
- the topic is one of the app's bundle ids (`APNS_TOPICS`).

It then sends an alert such as "A task needs your approval". The alert never
includes conversation content. When APNs reports that a token is dead, the relay
answers `{unregistered:true}`, and the Mac forgets that token.

Push is off (503) until these are set:

| Variable | Value |
| --- | --- |
| `APNS_KEY` | Contents of the `.p8` Auth Key (literal `\n` is accepted) |
| `APNS_KEY_ID` | The key's id |
| `APNS_TEAM_ID` | Apple team id |
| `APNS_TOPICS` | Optional comma list; default `ai.aegis.companion,ai.aegis.companion.dev` |

## Run locally

From the repository root:

```sh
npm ci
npm run dev:relay
```

The relay binds to `127.0.0.1:8788`. To point Aegis Dev at it, start the desktop with
`AEGIS_REMOTE_RELAY=ws://127.0.0.1:8788`. The phone accepts plain WS **only on
loopback** (the iOS Simulator); a real phone needs WSS.

## Deploy on Fly.io

`fly.toml` runs a single machine in `nrt`. Rooms are kept in memory, so don't scale
it out. TLS terminates at Fly.

```sh
cd services/relay
fly apps create <name>        # update `app` in fly.toml and DEFAULT_RELAY in src/electron/remote/relay-auth.ts
fly deploy
fly secrets set APNS_KEY="$(cat AuthKey_XXXX.p8)" APNS_KEY_ID=XXXX APNS_TEAM_ID=XXXX
curl https://<name>.fly.dev/health
```

A deploy or restart drops every tunnel once, and both ends reconnect. Scaling past
one machine would need room-affinity routing. `/health` reports only process health.

## Tests

`npm run verify:remote` covers:
- relay host proofs, token gating, tunnel replacement, IP caps, and the push gateway
  with a mocked APNs (`scripts/remote/relay.test.mjs`);
- the desktop gateway against a live relay (`scripts/remote/gateway-push.test.mjs`).

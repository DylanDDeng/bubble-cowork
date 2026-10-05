# Aegis relay (technical preview)

The relay forwards binary Noise ciphertext between one desktop and one active phone.
It never parses business commands or stores chat history. This implementation is a
single-process development relay, not a production multi-device service.

From the repository root:

```sh
npm ci
RELAY_REGISTRATION_TOKEN="$(openssl rand -hex 32)" npm run dev:relay
```

Keep the registration token in your deployment secret manager; use the same value
in desktop Settings → General → iPhone remote access. It is separate from the
phone routing token and from device authorization inside Noise.

The server binds to 127.0.0.1:8788 by default. Place it behind a TLS reverse proxy
that supports WebSocket upgrade and an idle timeout of at least 60 seconds. Use a
valid WSS URL on a real phone. The app accepts plain WS **only on loopback**, for
the iOS Simulator and local automated tests. No ATS or certificate verification
bypass is required or provided. `/health` only reports process health.

The first release needs operational hardening before public deployment: per-IP
connection limits, deployment rate limiting, availability/metrics, multiple-phone
routing, notification gateway and credential rotation. WebSocket ping/pong
reclaims stale tunnels; a global connection cap bounds pending connections.
The host reconnects after a phone disconnect so each connection gets fresh Noise
session keys. Only a device separately approved by the host can issue commands.

## Container

```sh
cd services/relay
docker build -t aegis-relay:preview .
docker run --rm --env RELAY_REGISTRATION_TOKEN -p 127.0.0.1:8788:8788 aegis-relay:preview
```

Provide the token via the environment; do not bake it into the image. Bind the
container port to loopback and terminate TLS at your existing reverse proxy.
The Docker recipe is supplied for deployment review; no remote service has been
deployed as part of this implementation checkpoint.

# Aegis for iOS (native)

SwiftUI app for iOS 26 with Liquid Glass. It replaced the earlier Capacitor
preview. The desktop is still the execution host. The phone talks to it over
the same encrypted `aegis.remote.v1` protocol, so no desktop changes are needed.

## Layout

| Path | What it is |
| --- | --- |
| `AegisKit/` | Swift package with everything that is testable without UI. `Crypto/` is Noise XX, the libp2p Ed25519 identity and PeerId, built on CryptoKit. `Transport/` is the relay WebSocket plus Noise and app framing. `Client/` is `RemoteClient`, a port of the old `client.ts`. `Storage/` is the Keychain and file cache. `Core/` is the JavaScriptCore bridge. |
| `core/` | TypeScript entry bundled into `aegis-core.js`. It runs the desktop's own transcript, workstream and catalog helpers from `src/ui/utils` in JavaScriptCore, so the phone's work trace and model pickers match the desktop. |
| `Aegis/` | The app: screens, composer, trace views, Markdown renderer, assets. |
| `project.yml` | XcodeGen spec. `Aegis.xcodeproj` and `aegis-core.js` are generated and not committed. |

## Build

From the repository root:

```sh
npm ci
npm run ios:project      # bundles core/ and generates apps/ios/Aegis.xcodeproj
open apps/ios/Aegis.xcodeproj
```

The Debug configuration builds **Aegis Dev** (`ai.aegis.companion.dev`, links
`aegis-dev://pair`). Release builds **Aegis** (`ai.aegis.companion`, `aegis://pair`).

These are the same bundle IDs and Keychain items as the earlier Capacitor app, so an
existing pairing and phone identity carry over. The Xcode build re-bundles
`core/` in a scheme pre-action, which needs `node` on the PATH. On a physical
phone, set your own development team.

## Test

```sh
npm run ios:test
```

This command:
- Runs the core render-model tests in Node.
- Runs `swift test` for AegisKit, which covers:
  - the libp2p PeerId vector;
  - Noise interop in both directions against the desktop's real `secure-channel` (`Tests/interop/noise-peer.mjs`);
  - concurrent large-message ordering;
  - JavaScriptCore rendering;
  - an end-to-end run of `RemoteClient` against `scripts/remote/fixture.mjs` (pair, snapshot, history, approval, chunked upload, create with settings and attachments, forget).

## Run against Aegis Dev

1. Start a relay:

   ```sh
   RELAY_REGISTRATION_TOKEN=… npm run dev:relay
   ```

   The simulator may use `ws://127.0.0.1:8788`; real phones need WSS.
2. Start Aegis Dev with `npm run dev`.
3. In Settings → General → iPhone Access, set the relay and token, choose projects, and show the pairing code.
4. In the app, scan the code, or open the link with `xcrun simctl openurl booted 'aegis-dev://pair#…'` and tap Connect.
5. Approve the device on the Mac.

## Notes

- **Not available on the phone yet:** answering agent questions, approving plans, file preview and push notifications. These need host APIs.
- **Drafts** are files under Application Support, written on every change.
- **The snapshot cache** is a per-Mac JSON file.
- **Removing the Mac** clears the cache, drafts, pairing and journal, but keeps the phone identity.

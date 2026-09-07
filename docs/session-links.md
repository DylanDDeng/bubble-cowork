# Conversation links and workspace reuse

## Verified Codex reference

Inspected `/Applications/Codex.app`, version **26.901.41600**, build **7982**.
The installed app was read and extracted to a temporary directory; it was not
modified or re-signed. Reproduce the focused source audit with:

```sh
node scripts/inspect-codex-session-links.mjs
```

The report at `output/session-links-qa/codex-source-evidence.json` records archive
entries, source hashes, offsets and short excerpts. These are verified mechanisms:

1. In `app-initial-86767c3d23e5.js`, `Bqi` copies
   `codex://threads/<id>`; `zqi` copies the cwd as plain text. `dAn` and the shared
   menu builder in `app-primary-139889e10fbd.js` expose the copy actions in both
   sidebar and header menus.
2. The composer collects structured thread references. `Lqr` deduplicates them,
   omits self-references, resolves the host and rejects unsupported references.
3. Prompt construction adds reference identifiers with the instruction
   “These are live references to Codex tasks, not task contents” and requires
   `read_thread`. It does not substitute five recent messages for local task
   references. ChatGPT conversation references have a different cached-preview
   path; that path is not the basis for this local-session implementation.
4. `T2t` checks whether the thread-start dynamic tool catalog or the per-thread
   `mcp_servers.codex_app.enabled_tools` override contains `read_thread`.
   `GXr` displays “Task references aren't available here. Remove them or start
   a new task” when capability is missing.
5. There are two app-tool paths: dynamic tools in thread-start parameters and
   a bundled desktop MCP bridge. The main process's `tk` returns MCP config
   overrides to the Core launcher, rather than persisting a new server entry
   in the user's agent config for this operation. The bundled
   `plugins/openai-bundled/plugins/codex-app-tools/server.mjs` forwards
   `tools/list` and `tools/call` to the app through `CODEX_APP_TOOLS_PIPE_PATH`.
   `RXi` dispatches `read_thread` to the app's history reader with pagination.

## Aegis behavior

Both the sidebar context menu and the header ellipsis use one action hook and
Electron's native `Menu.popup`. On macOS, SF Symbols come from
`nativeImage.createMenuSymbol`; the system supplies spacing, translucency, shadow,
selection color, submenus and keyboard tracking. This follows Codex's verified
`electronBridge.showContextMenu` path. Other application dropdowns are unchanged.

Both menus contain Pin/Unpin, Copy, provider-gated Fork, Worktree, and Delete.
Copy and Worktree are submenus; two separators divide the groups. Worktree pending
state is shared between the header, sidebar and split-pane headers. Running and
draft guards and destructive-action confirmation dialogs remain in effect.

The **Copy** submenu offers:

- **Conversation link**: `aegis://sessions/<aegis-session-id>`.
- **Working directory**: the persisted cwd, including its actual worktree.
  Drafts can copy their selected cwd but have no persisted conversation link.

Pasting a link renders an atomic chip with the locally known title. Serialization
preserves the URI; Backspace/Delete removes the whole chip. No favicon is fetched.
The main process validates references before workspace/handoff changes, omits
self-references and deduplicates up to eight IDs. Missing or hidden sessions fail
explicitly. Unsupported runtime references are rejected in the composer before
clearing its input, and checked again in the main process. The original user message is retained; only the runner prompt receives
reference metadata and the instruction to call the application reader.

Reading a reference does not resume, fork or delegate a task. Copying a cwd does
not automatically change the destination session's cwd. The link can also navigate
to the source conversation through Aegis's deep-link handler.

## Runtime-only tools

The shared reader belongs to Aegis. It is exposed through the runtime's tool
extension mechanism, with no new entry in user-level agent configuration.

| Runtime | Application tool injection |
| --- | --- |
| Claude / compatible Claude backends | In-process SDK MCP, separate from delegate tools |
| Codex | `-c` MCP override on the Aegis-owned app-server process |
| Bubble | Native read-only tool in Aegis's SDK instance; no MCP config file |
| Pi | SDK `customTools`, included in the active tool allowlist |
| Qoder | Query `options.mcpServers` |
| OpenCode | SDK server config passed through `OPENCODE_CONFIG_CONTENT` |
| DeepSeek | Existing disposable MCP runtime configuration, removed on disposal |
| Grok | ACP `session/new` or `session/resume` MCP parameters |
| Kimi web daemon | Reference submission rejected; ordinary messages still work |

Kimi's installed web-daemon interface did not expose a verified runtime-only MCP
injection option. The previous global-file workaround has been removed. Like
Codex's unavailable-capability path, Aegis fails before sending a reference instead
of silently substituting an incomplete recent-history preview.

Bubble 0.0.56 has no public `extraTools` option. The Aegis-specific adapter wraps
that **instance's** `mcpToolsFor` assembly method, preserves existing discovered
MCP tools and adds the native reader. No SDK file, user settings, or environment
variables are patched. This internal SDK seam is an Aegis adaptation, not a claim
about Codex's Bubble support. Tests exercise the actual SDK agent loop, and a
missing seam or missing resolved tool produces an explicit error.

HTTP transports bind to authenticated loopback endpoints owned by the app. The
namespace is `aegis-sessions`; its only tool is `read_session`. Native SDKs expose
`read_session` directly. Neither transport contains delegation tools.

## Reading and navigation

`read_session` accepts `sessionId`, optional opaque `cursor`, `limit` (1–20,
10 by default) and `maxMessageChars` (1–12000, 3000 by default). It reads the
persisted Aegis database and returns metadata, cwd, status, newest-first message
summaries, truncation flags and `nextCursor`/`hasMore`. Follow the cursor for older
history; repeat a page with a larger character limit when content is truncated.
System/stream-only rows are omitted, so an empty page with `hasMore` still requires
paging. A composite sort/creation/ID cursor remains stable during new appends.

Aegis pages stored messages; Codex pages turn summaries. That storage-specific
choice and the `read_session` name are adaptations. The shared behavior is a live
reference followed by explicit, bounded reads rather than automatic history copying.

Packaged builds register the `aegis` protocol. Cold-start URLs are queued until the
renderer requests its session list. Development/test launches do not take over the
installed app's protocol registration.

## Validation

`npm run verify:session-links` uses an isolated Electron profile with real menus,
composer, preload, database and MCP transport. It verifies both menu entry points,
clipboard identity and persisted cwd, dismissal, paste/deletion, unavailable and
missing references, stable pagination, truncation, SDK/HTTP reads and navigation.
It runs the actual Bubble SDK agent loop against a deterministic fake model:
read the reference, follow its cursor, then finish without any Bash call. It checks
Pi's real active tool catalog, config-byte preservation and runtime-only Codex args.
The automated menu checks construct real native menus and substitute only OS popup
tracking for deterministic selection, with an in-memory clipboard to avoid
interfering with concurrent user copy/paste. They compare both entry points, verify SF
icons, action guards, IPC results and close callbacks. Manual validation in an
isolated Electron app also opened the real native menus and Copy submenu and
copied/pasted the target reference. The screenshot API captures the parent window
without native popup windows, so earlier header/sidebar PNGs are from the previous
HTML menus and are not evidence of the new appearance.
Model API calls and installed-app Launch Services are not exercised.

The broad DeepSeek verification currently has a pre-existing static assertion for
`id: 'deepseek-project'`, absent in both HEAD and the current settings UI. The
reader's transport and the disposable-config checks are separate from that failure.

Existing app processes must restart to load these changes; no user session is
interrupted or automatically replayed by this implementation.

# Kimi Server Adapter Plan (v2 — post-review)

Replace the ACP stdio integration (`kimi-acp-adapter.ts`) with a `kimi server`
(REST + WebSocket) integration, closing the gaps ACP cannot: per-session
usage, model switching mid-session, compact/fork, prompt queueing + steer,
durable server-side sessions, and turn-level cancel that does not kill the
whole runtime.

Status: **IMPLEMENTED** (2026-07-17) — M0 probes run live against 0.26.0
(results in the appendix; two plan assumptions were corrected: the daemon is
a machine-wide singleton, and ACP↔server session spaces are disjoint).
M1+M2 landed as `kimi-server-manager.ts` + `kimi-server-adapter.ts` +
`kimi-adapter-facade.ts` (provenance routing, `server:` id prefix). New
threads default to the server runtime when the CLI is capable;
`AEGIS_KIMI_RUNTIME=acp|server` overrides (dev-only). Tests:
`verify:kimi-server` (25 L1 + 10 L2, in the `npm test` chain) plus the live
smoke `scripts/verify-kimi-server-e2e.mjs` — all green against 0.26.0.

Original design status: v2 — probed against Kimi Code 0.26.0 (2026-07-17),
then reviewed by a three-lens panel (architecture / live-protocol
verification / rollout-risk). v1's protocol guesses are replaced by verified
calls below; review findings are folded into the design and milestones.

## Why kimi server (and not the SDK, and not more ACP)

| | ACP (today) | node-sdk | kimi server |
| --- | --- | --- | --- |
| Availability | shipped | not on npm (`@moonshot-ai/kimi-code-sdk` 404) | ships inside the CLI |
| Process isolation | ✅ child proc | ❌ in-process `KimiCore` inside Electron main | ✅ separate daemon |
| Usage / context data | ❌ none | ✅ | ✅ WS `turn.step.completed` + `agent.status.updated` |
| Mid-session model switch | ⚠️ set_config_option exists but our sendTurn never calls it | ✅ | ✅ per-prompt `model` field |
| Compact / fork / steer / queue | ❌ | ✅ | ✅ verified live |
| Turn cancel without killing runtime | ❌ (we SIGTERM the proc) | ✅ | ✅ `:abort` verified |
| Session history & recovery | resume-by-id only | ✅ | ✅ server-persisted sessions + `GET /messages` + seq replay |
| API stability | ACP spec | typed | ⚠️ undocumented `/api/v1`, capability-probed (not version-allowlisted) |

The SDK being published would not change this choice: its in-process
architecture gives up crash isolation inside Electron main.

## Verified surface (0.26.0 — all calls exercised live)

Daemon: `kimi server run --port <p>` → prints bearer token (token is
**persistent across restarts**, not per-run; `rotate-token` invalidates it);
loopback-only by default; auto-exits with zero connected clients after ~60s
unless `--keep-alive`; `kimi server ps|kill`.

### REST `/api/v1` (bearer auth, `{code, msg, data}` envelope, zod-validated)

- `POST /sessions` `{metadata: {cwd}}` → session. **A fresh session has no
  model and the server does NOT apply config `default_model`** — submitting
  without `model` fails with `turn.ended {reason:"failed",
  error:{code:"model.not_configured"}}`. Always pass `model` on submit (or
  set via `POST /sessions/{id}/profile`).
- **Prompt submit**: `POST /sessions/{id}/prompts`
  `{content: [{type:'text',text}|image|file|…], model, thinking?,
  permission_mode?, plan_mode?, agent_id?}` → `{prompt_id, status:
  "running"|"queued", …}`. Returns immediately; the turn streams over WS
  (codex-style async, NOT ACP-style blocking). `model`/`thinking`/
  `permission_mode` are applied to the agent profile before enqueueing —
  per-turn model switch is one call.
- **Queue**: submit-while-busy → `status:"queued"`;
  `GET /sessions/{id}/prompts` → `{active, queued[]}`.
- **Steer**: `POST /sessions/{id}/prompts:steer` `{prompt_ids:[…]}` drains
  queued prompts into the active turn (verified mid-turn). Per-prompt
  `POST /sessions/{id}/prompts/{prompt_id}:abort` / `…:steer` also exist.
  (v1 wrongly mapped steer to `:btw` — `:btw` spawns a side agent and takes
  no text; not needed for our steer feature.)
- **Session actions**: `POST /sessions/{id}:abort` (turn-level cancel,
  verified: `{"aborted":true}` + WS `turn.ended {reason:"cancelled"}`,
  session stays usable), `:fork` (returns new session), `:compact` (async;
  completion = WS `event.session.history_compacted`), `:undo`, `:restore`,
  `:archive`.
- **Approvals**: `GET /sessions/{id}/approvals?status=pending`;
  resolve via `POST /sessions/{id}/approvals/{approval_id}`
  `{decision: "approved"|"rejected"|"cancelled", scope?: "session",
  feedback?, selected_label?}`. Questions are parallel:
  `GET/POST /sessions/{id}/questions/{question_id}`, `…:dismiss`.
- `GET /sessions/{id}/messages` — persisted transcript (incl. thinking and
  tool_result blocks).
- `GET /models` (with `max_context_size`), `GET /workspaces`, `GET /config`,
  `/files`, `/healthz`, `POST /shutdown`, `/terminals/*`.
- ⚠️ **Stub fields**: `GET /sessions` items' `usage`, `agent_config.model`,
  `message_count`, `last_seq` are hardcoded empty in 0.26.0
  (`toWireSession`). Usage/context/model MUST come from WS events; resume
  cursors from subscribe acks.
- Permission modes are `manual | yolo | auto` (v1's `default/plan` was
  wrong); plan mode is a separate `plan_mode: boolean` on the prompt. UI
  mapping: default→`manual`, plan→`manual`+`plan_mode:true`, auto→`auto`,
  yolo→`yolo`.

### WS `/api/v1/ws` (bearer auth, protocol v2)

- Envelope `{type, timestamp, id?, payload}`. Server opens with
  `server_hello`; client sends `client_hello` (may inline
  `payload.subscriptions: [session_id]`).
- `subscribe`: `{type:'subscribe', id, payload:{session_ids:[…], cursors?,
  watch_fs?, agent_filter?}}` → ack with `{accepted, not_found,
  resync_required, cursors: {sid: {seq, epoch}}}`. Cursors are
  `{seq, epoch}` objects. `resync_required` reasons: `buffer_overflow |
  session_recreated | epoch_changed`. Server pings `{nonce}` → client must
  `pong`. Other client types: `unsubscribe, abort {session_id, prompt_id},
  watch_fs_*, terminal_*`.
- Event envelope `{type, seq, session_id, timestamp, payload, epoch}`.
  Session scope: `event.session.work_changed {busy, main_turn_active,
  pending_interaction, last_turn_reason}`, `event.session.created/updated`,
  `event.approval.requested/resolved`, `event.question.*`,
  `event.session.history_compacted`, `session.meta.updated`. Agent scope
  (no prefix): `turn.started`, `turn.step.started/completed/interrupted`,
  `turn.ended {reason: completed|failed|cancelled, error?}`,
  `thinking.delta`, `assistant.delta`, `tool.call.started/delta`,
  `tool.progress`, `tool.result`, `context.spliced`,
  `agent.status.updated {model, contextTokens, maxContextTokens,
  thinkingEffort}` (**volatile: not replayable, may share seq with
  neighbors**), `prompt.completed/aborted`, `error`.
- **Usage**: `turn.step.completed.payload.usage`
  `{inputOther, output, inputCacheRead, inputCacheCreation}`.
- Approvals push TWO near-duplicate frames per request
  (`permission.approval.requested` + `event.approval.requested`) — dedupe
  by `approval_id`/`tool_call_id`.

## Architecture

```
src/electron/libs/provider/
  kimi-server-manager.ts   — daemon lifecycle + REST/WS client (transport-injectable)
  kimi-server-adapter.ts   — ProviderAdapter, maps events → StreamMessage
  kimi-acp-adapter.ts      — stays; routed per-thread behind a facade (see Rollout)
```

### Transport prerequisites (review blocker)

Electron 34 main = Node 20: **no built-in WebSocket client**. Add `ws` as a
dependency (pure JS, no native-deps impact); the L2 fake server uses the same
package's server class. `fetch` is available.

### KimiServerManager

- **Spawn**: `kimi server run --foreground --port <random>` as a child;
  parse token from stdout with a per-version-pinned regex (persistent token
  file is the fallback). Single-flight spawn barrier; readiness gated on
  `GET /healthz`. `--foreground` semantics (child pid == serving pid; SIGTERM
  stops the listener) are an M0 probe — if `run` daemonizes, we must track
  the real pid via `kimi server ps`.
- **Generations** (imported from codex's hard lessons): every spawn gets a
  generation number; sessions carry the generation they were created on.
  Child exit ⇒ `cleanupGeneration`: abort all in-flight fetches
  (per-generation `AbortController`), close the WS, **dismiss all pending
  approvals/questions** (`permission_dismissed`), mark sessions stale
  (stale ops throw). Respawn ⇒ new port + new baseURL + re-read token;
  sessions recover only via server persistence + resubscribe.
- **Three failure domains, distinguished**: (a) WS dropped but server alive
  → reconnect with backoff (capped well under 60s), resubscribe with stored
  `{seq, epoch}` cursors; (b) server dead (REST/WS ECONNREFUSED) → full
  respawn path; (c) child exit event → same as (b) minus probing.
- **Quit ordering**: `ipc-handlers.ts cleanup()` (before-quit) gains a
  synchronous daemon kill (child.kill + best-effort `POST /shutdown`) —
  today nothing calls `stopAll()` on quit and an HTTP daemon won't die on
  stdio EOF like ACP children do. The 60s idle-exit remains the unclean-exit
  safety net only.
- **Idle-exit interaction**: whether a connected WS counts as a "client" for
  the 60s timer is an M0 probe. Regardless of the answer we pass
  `--keep-alive` (we own the lifecycle and kill on quit) and keep the
  respawn path for daemon death from any cause (sleep/wake, crash).
- **REST client**: fetch wrapper adding bearer + unwrapping the envelope
  (`code !== 0` → typed error). Injectable `fetch` + WS factory in the
  constructor — required for L1 tests (day-one constraint, not a retrofit).

### KimiServerAdapter (implements ProviderAdapter)

| ProviderAdapter | kimi server (all verified) |
| --- | --- |
| `startSession` | `POST /sessions {metadata:{cwd}}`; resume = server-persisted session id (see Rollout for ACP-id provenance); subscribe WS; emit `system_init` (id + model) immediately; emit a visible degradation notice if a persisted session is gone (codex P0-5 pattern) |
| `sendTurn` | `POST /sessions/{id}/prompts` with content blocks; always pass `model` (C3); map permission mode (`manual|yolo|auto` + `plan_mode`); busy → submit (queues server-side) and offer steer via `prompts:steer` |
| `stopSession` | `POST /sessions/{id}:abort`, then **release the adapter binding** (service deletes the directory entry regardless — keeping it desyncs `hasSession`); emit `stop_settled` on the `turn.ended {reason:"cancelled"}` confirmation with a safety timeout; extend the ipc two-phase-stop gate (`provider === 'codex'`) to kimi |
| `stopAll` | abort turns, close WS, kill daemon child |
| `respondToRequest` | approvals: `POST /sessions/{id}/approvals/{approval_id}` mapping `PermissionResult.behavior` → decision (+`scope:'session'` passthrough); questions via questions routes; emit `permission_dismissed` on `event.approval.resolved` (another client may answer — sessions are multi-client), on stop, and on daemon death; **fail-closed routing**: interactions keyed by exact server session id, unroutable ⇒ decline (codex P0-7) |
| `forkThread` | `POST /sessions/{id}:fork` → `forkThread: true` |
| `compactThread` | `POST /sessions/{id}:compact`; `event.session.history_compacted` → compact_boundary message → `compactThread: true` |
| usage / context | WS `turn.step.completed.usage` → token_usage messages; `agent.status.updated` → context ring (`contextTokens`/`maxContextTokens`) — NOT the stubbed REST fields (C1) |
| model switch | real, per-prompt → `sessionModelSwitch: true`; `getComposerCapabilities.supportsRuntimeModelList: true` backed by `GET /models` |
| `runOneShot` | implement with `:archive` cleanup afterward — the generic fallback would litter the server's persistent session store with one session per title generation |

**Turn-terminal invariant** (review blocker, now specified): the sole
terminal source is `turn.ended` (`completed|failed|cancelled`), with
`prompt.completed/aborted` used only for queue bookkeeping. Exactly one
`result` StreamMessage per turn; on `failed`, the `error` event precedes the
error result (service.runOneShot classifies by arrival order); no second
success channel may overwrite a failure (codex P0-1).

**Event replay idempotence**: emit only events with `seq >` last-emitted per
session; volatile frames (`agent.status.updated`) are excluded from cursor
math (may duplicate/share seq). `resync_required` ⇒ do NOT re-emit the
transcript: finalize any open streaming accumulator, refetch
`GET /messages` for reconciliation keyed by stable message ids (emitted-id
sets, as codex/opencode do), and surface a visible notice if a gap cannot be
reconciled seamlessly.

**One-owner guard**: durable multi-client sessions make double-binding more
likely, not less — refuse to bind a server session id already bound to
another live Aegis thread (codex `CodexThreadBindingError` pattern).

### What stays as-is

- `kimi-runtime-status` — gains a `serverAvailable` probe in M1 (today it
  only probes `kimi acp`); routing decisions are capability-based.
- `kimi-settings` / `kimi-mcp-settings` — unchanged.
- ACP adapter — stays in-tree, reachable per-thread via the facade below.

## Rollout (rewritten per review)

**Per-thread runtime provenance, not a global flag.** The registry holds one
adapter per provider, so registration uses a thin **facade adapter** for
`kimi` that routes each thread to the ACP or server implementation based on
provenance stored with the session (`kimi_session_runtime` column or a
`server:`/`acp:` id prefix in `kimi_session_id`). The
`AEGIS_KIMI_RUNTIME`-equivalent setting only picks the default for **new**
threads (settings UI; env var is dev-only since Finder-launched apps don't
see shell env).

**No failure-triggered fallback.** Runtime choice is capability-based and
deterministic (`kimi server` subcommand present + healthz + one
schema-validated `GET /sessions`); a transient boot failure of a capable CLI
retries with backoff and surfaces an error — it must NOT flip the thread to
ACP, because flapping between runtimes corrupts resume ids (see below).
Unknown CLI versions are NOT auto-downgraded (that's a version allowlist in
disguise — the capability probe decides; fall back only on actual protocol
breakage, loudly).

**Session-id continuity is unproven and is M0's second-biggest probe**: are
ACP-created session ids visible in the server's session store, and vice
versa? Until proven, a thread only ever resumes on the runtime that created
it (provenance above). If cross-runtime resume is impossible, migrating an
old thread shows an explicit "context was reset" system message — never
silent. A still-valid old-runtime id is never overwritten until the new
runtime has produced one successful turn.

**Milestones**

- **M0 — protocol pinning, remaining items** (the prompt/WS/approval shapes
  are already pinned by the live review): (1) ACP↔server session-id space
  visibility, both directions; (2) `--foreground` semantics + pid tracking;
  (3) does a connected WS hold off the 60s idle exit; do seq cursors survive
  daemon restart; (4) two daemons over one session store (multi-instance
  Aegis); (5) `:abort` ack-vs-terminal timing for `stop_settled`;
  (6) `prompts:steer` behavior when the turn ends in the race window.
  Deliverable: `scripts/probe-kimi-server.mjs` + protocol appendix; the
  script doubles as the post-CLI-upgrade canary.
- **M1 — manager + adapter + facade** behind the new-thread default setting;
  `ws` dependency; injectable transports; feature parity with ACP (stream,
  thinking, tools, plan, approvals, images via content blocks, resume).
- **M2 — the wins**: real model switching; usage + context ring; stop =
  `:abort` with `stop_settled` and the ipc gate extension; queue + steer
  composer UX (codex-style); fork/compact capabilities + `/compact` command
  wiring.
- **M3 — default flip for new threads**; old threads stay on their
  provenance runtime; ACP removal only after a full release cycle and only
  if cross-runtime resume (or recap-injection migration) is solved.

**Testing — `verify:kimi-server`**: L1 in-process against injected
fetch/WS-factory fakes (turn terminals incl. failed/cancelled dedup, seq
replay + volatile frames, resync reconciliation, approval dedupe + dismiss,
stop→settle→replacement-runner ordering, ACP-id-on-server-runtime resume
failure path, provenance stickiness). L2 against a fake HTTP+WS server
(`ws` server class): token parse variants (clean/malformed/delayed/never),
healthz gating, EADDRINUSE respawn, daemon exit mid-turn (pending REST
rejected, turn errors instead of hanging), WS drop + cursor resubscribe,
deep-backlog resync, quit kill ordering.

## Risks

- **Undocumented API**: capability probe at adapter init (healthz + one
  schema-validated list call); M0 harness re-run after CLI upgrades. Loud
  breakage over silent downgrade.
- **REST stub fields** (C1) may become real in later CLI versions — the
  adapter must keep treating WS as the source of truth; harmless if REST
  catches up.
- **Token lifecycle**: token is persistent; `rotate-token` by the user
  invalidates our cached copy → treat 401 as daemon-restart-equivalent
  (re-read token / respawn).
- **Multi-instance**: one daemon per Aegis process on a random port; the
  shared on-disk session store's concurrent-write behavior is an M0 probe.
  v2 "reuse existing daemon" stays out of scope until ownership semantics
  exist. **[Superseded by M0 findings: the daemon is a machine-wide
  singleton — see appendix.]**

## Implementation notes (deviations from the design, all probe-driven)

- **Daemon adoption instead of daemon-per-process**: the singleton refusal
  (`server already running (pid, port)`) is parsed and the existing daemon is
  adopted (token from `~/.kimi-code/server.token`). `killSync()`/`stop()`
  only kill a daemon we spawned; adopted daemons are left alive on quit.
- **Steer is an optimization**: queued prompts auto-advance when the active
  turn ends (probe), so `sendTurn` submits, and only steers when the session
  had an active turn at submit time; the 40402 race is swallowed as benign.
- **Usage/context UI**: the kimi server runtime reuses the codex
  `token_usage` message shape (`provider: 'kimi'`) and the codex context
  ring (`CodexContextIndicator`); `turn.step.completed.usage` feeds tokens,
  volatile `agent.status.updated` feeds `contextTokens/maxContextTokens`.
- **ipc two-phase stop**: the codex-only gates generalize through
  `isTwoPhaseStopProvider()` (codex + kimi); the ACP runtime settles
  synthetically in the facade so the gate can never hang on old threads.
- **Quit ordering**: `ipc-handlers.ts cleanup()` calls the facade's
  `killServerDaemonSync()` (best-effort POST /shutdown lives in the async
  `stop()` path).
- **runOneShot** uses the server runtime and `:archive`s the throwaway
  session; on an ACP-only CLI it falls back to a collect-until-result loop.
- **Composer slash catalog**: the server has NO commands endpoint (route
  table extracted from the binary) and does NOT parse slash text in prompts
  (`/help` goes straight to the model — probed). The adapter therefore emits
  `available_commands_update` itself after session start: `/compact`
  (adapter-routed to `:compact`) + `skill:<name>` per
  `GET /sessions/{id}/skills` (`{skills:[{name, description, path,
  source}]}`, builtins included). `/skill:name args` submitted as prompt
  text DOES trigger the skill (KimiCore expands it in-turn — verified live).
  ACP-only runtime builtins (`/status`, `/usage`, `/mcp`, `/tasks`, `/help`)
  are deliberately not advertised on the server runtime.
- **Session-independent skills for the composer** (codex-style): the session
  catalog above only exists after a session starts, which left the
  NewSessionView and pre-first-turn composers empty. `KimiServerAdapter.
  listSkills` (adapter skill-discovery API) lists skills without a session:
  `GET /workspaces` → match `root` to cwd → `GET /workspaces/{id}/skills`
  (any workspace as fallback — skills are predominantly global); a throwaway
  archived session only when no workspace exists. 30s per-cwd cache. Exposed
  as the `kimi-list-skills` IPC (`window.electron.listKimiSkills`); the
  composer hook loads it for kimi like the codex path and shows skills in
  the `/` popup (limit 80). Selecting one inserts literal `/skill:<name> `
  text — kimi has no skill-reference pipeline. The `skill:<name>` variants
  are also registered in the slash token context (+ display labels without
  the prefix), so the inserted token renders as an inline skill chip in the
  composer, pre- and post-session.

- **Thinking** (probed 2026-07-18): the prompt-submit `thinking` field is an
  effort-tier STRING, not a boolean (`thinking: true` → 40001 zod error).
  Tiers are an open set (`off | on | low | medium | high` seen in the
  binary), validated per-model server-side: `kimi-for-coding` supports only
  `off` (50001 otherwise); thinking-capable models (`kimi-k2.x`, per the
  `thinking` entry in model `capabilities`) accept `on`/`off`, default to ON
  when unset, and lax-normalize unknown strings to `on`. k2.5 currently
  fails upstream (`400 thinking.keep is not supported`) even without
  thinking — a CLI↔moonshot mismatch, not ours; k2.6 works end-to-end with
  streamed `thinking.delta {turnId, delta}` frames. Aegis wiring:
  `kimiThinking?: 'on' | 'off'` rides start/continue payloads →
  `KimiServerAdapter` (sticky per session, omitted when unset) → submit
  `thinking`; the agent/model picker's Kimi submenu carries a
  Codex/Claude-style "Thinking" section. **Tier sets are per-model
  metadata** (probed 2026-07-18): the server's `GET /models` exposes
  `support_efforts` + `default_effort` for k3-class models
  (`kimi-code/k3`: off/low/high/max, default max; `moonshot-cn/kimi-k3`:
  off/max), while k2.x thinking models are on/off and `always_thinking`
  models can't disable thinking by default. The UI derives its options
  entirely from that metadata (no tier whitelist): `get-kimi-model-config`
  enriches the CLI list via the facade's cached server `GET /models`
  (`mergeKimiServerModelMetadata`); a stored preference is only SENT when
  valid for the current model, otherwise the submit omits `thinking` and
  the checked item falls back to the model default. The trigger label
  suffixes the active tier (" Thinking" for on, " Max"/" High"/… for
  tiers). The ACP runtime ignores the flag (old threads no-op).

- **Settings usage report**: the Usage tab's kimi card aggregates persisted
  `result` messages (`getClaudeProtocolUsageReport('kimi')`), and both kimi
  adapters used to emit zero-usage results — so the card was always empty.
  The server adapter now accumulates `turn.step.completed.usage` per turn
  and emits it on the result (Claude shape: input/output/cache_read/
  cache_creation + `model` for attribution). Cost stays 0 — the server
  reports no per-turn cost, and there is no account-level quota/usage
  endpoint anywhere in the CLI surface (binary-mined; membership quota is
  docs-only). ACP threads keep zero usage (the protocol carries none).
  Historical pre-fix usage is unrecoverable from ALL four sources (zeroed
  Aegis results, last-step-only token_usage rows, stubbed server session
  usage, usage-less server /messages — all verified live).
- **Per-turn token_usage ledger**: the kimi `token_usage` uuid is stable per
  TURN (`kimi-token-usage-<thread>:<turnId>`), not per session, and carries
  the turn-CUMULATIVE tokens + context watermark. Steps within a turn still
  overwrite in place (smooth ring, no row spam), but each finished turn
  leaves one appended row — a per-turn usage timeline in the transcript DB
  (`addMessage` upserts by uuid). Step-level within-turn history is
  deliberately sacrificed.

- **Fork wired end to end** (2026-07-19, reviewed by a three-lens panel):
  the ipc `forkProviderThreadSession` routes kimi via `kimi_session_id`
  (stored verbatim with the `server:` prefix), with a provenance pre-check
  that returns a friendly error for legacy-runtime ids. The dispatch now
  `return await`s the fork so adapter rejections hit the catch → toast
  (previously a silent unhandled rejection — also fixed codex/opencode in
  passing). UI enables the menu item for kimi and disables it while a turn
  runs (fork-mid-turn semantics unprobed). Probed on 0.27.0: the server
  fork copies the FULL history (22/22 messages verified), forks of forks
  work, archived sessions still fork (archive ≠ delete), `:fork` errors ride
  the envelope code on HTTP 200, and a fork's WS cursor starts fresh (its
  history never replays over WS — `GET /messages` or the local mirror only).
- **Logical ACP removal + legacy adoption** (2026-07-19, three-lens panel
  review + live probes): bare-id (legacy) thread resumes no longer default
  to the ACP runtime. The facade first asks the server to adopt the bare id
  (explicit WS subscribe): ACCEPTED → the same session continues on the
  server runtime with full history (probed on 0.27.0 including a real
  2026-07-03 legacy session — list/messages/subscribe/ACP-round-trip all
  green), and the prefixed `system_init` rewrites the DB id to
  `server:<same id>` (reversible in the sense that the underlying id is
  preserved under the prefix). NOT_FOUND → the thread stays on the legacy
  runtime with its id untouched — a still-valid legacy id is never
  destroyed (honors the Rollout invariant). Adoption is gated on the same
  deterministic capability probe as new threads; a daemon boot failure on a
  capable CLI throws loudly (no runtime flapping). `AEGIS_KIMI_RUNTIME=acp`
  is an escape hatch for the MIGRATION STEP only: new threads and
  not-yet-adopted legacy threads run on ACP, but already-migrated
  (`server:`-prefixed) threads keep using the server daemon, and composer
  capabilities follow the override — it is not a full server-runtime kill
  switch. Successful adoption is silent in the UI (a console.info log
  only), matching how successful resumes behave for every provider.
  Physical deletion of `kimi-acp-adapter.ts` is deferred until the adopted
  paths have survived a release cycle. Known edge: a bare id equal to an
  already-bound server id surfaces `KimiThreadBindingError` as a raw runner
  error; the DB id stays bare and a later retry works.
- **Ack-shape gotcha (0.27.0)**: `client_hello` INLINE subscriptions ack
  with `accepted_subscriptions`/`resync_required` and have NO `not_found`
  field; explicit `subscribe` messages keep the full
  `accepted/not_found/resync_required` payload. The manager only uses
  explicit subscribes, so not_found semantics hold; never key logic off the
  inline-ack shape. (`POST /sessions/{id}:archive` — colon action — remains
  the correct archive form; the slash form `/{id}/archive` is
  `unsupported action`.)
- **0.27.0 canary** (2026-07-19): all surface probes match this appendix;
  one delta — a live daemon now sees ACP-created sessions in
  `GET /sessions` without a restart, but ACP resume of server sessions
  still fails, so provenance stickiness is unchanged. The probe script now
  ADOPTS a running daemon (Aegis open) and skips ownership-dependent
  lifecycle probes instead of dying on the singleton refusal.

## Appendix: M0 probe results (0.26.0, 2026-07-17, `scripts/probe-kimi-server.mjs`)

All probes run live against Kimi Code 0.26.0. Re-run the probe script after
CLI upgrades and diff against this appendix.

1. **The daemon is a machine-wide singleton.** A second
   `kimi server run --foreground --port <other>` exits 1 with
   `server already running (pid=N, port=N, started=…)` on stderr (parseable).
   The manager must ADOPT an existing daemon (parse port from the refusal,
   read the token from `~/.kimi-code/server.token`) instead of assuming
   per-process daemons. Kill-on-quit applies only to a daemon we spawned.
2. **Token**: printed at startup as `  Token:    <base64url>` (also inside the
   web-UI URL fragment) and persisted at `~/.kimi-code/server.token`. Same
   token across restarts (persistent, as designed). Regex:
   `/^\s*Token:\s+(\S+)\s*$/m`.
3. **`--foreground` semantics confirmed**: child pid == serving pid, SIGTERM
   exits 0 and frees the port; keep-alive is always on in foreground mode
   (per `--help`), so the 60s idle exit is moot for us.
4. **ACP ↔ server session spaces are disjoint at runtime.** A server-created
   session cannot be resumed over `kimi acp` (`Agent "main" was not found`);
   an ACP-created session does not appear in a live daemon's `GET /sessions`
   (the shared disk store is only re-read at daemon boot). Provenance
   stickiness is mandatory; no cross-runtime resume.
5. **Sessions with no turns do not survive daemon restart**; resubscribing
   after a restart returns the id under `not_found` (empty `accepted`).
   A `not_found` subscribe result means no events will ever arrive for that
   id on this connection, even if the session is later re-created — treat as
   resume failure (visible degradation notice) and re-create + re-subscribe.
6. **Envelopes**: list endpoints return `data.items[]` (`/models`,
   `/sessions`, `/approvals`). Session objects use `id` (not `session_id`).
   `GET /sessions` items DO carry a `usage` object but it is all-zeros in
   0.26.0 (stub confirmed) — WS remains the only usage/context source.
7. **WS event envelope**: `{type, seq, session_id, timestamp, payload, epoch,
   volatile?, offset?}`. Volatility is a top-level `volatile: true` flag
   (`agent.status.updated`, `assistant.delta`, `tool.call.delta`, phase
   frames) — key cursor math off the flag, not a type list.
   `assistant.delta` carries a top-level `offset` (cumulative text offset)
   usable for replay dedupe. Subscribe ack: `{type:'ack', id, code, msg,
   payload:{accepted, not_found, resync_required, cursors:{sid:{seq,epoch}}}}`
   (a `client_hello` with inline subscriptions acks with
   `accepted_subscriptions` instead of `accepted`).
8. **Turn event flow** (verified): `turn.started {turnId, origin}` →
   `turn.step.started` → `tool.call.delta`* (volatile, streaming args) →
   `tool.call.started {toolCallId, name, args, description,
   display:{kind,operation,path|command…}}` → `tool.result {toolCallId,
   output}` → `turn.step.completed {usage:{inputOther, output,
   inputCacheRead, inputCacheCreation}, finishReason}` → `assistant.delta`*
   → `turn.ended {reason, durationMs}` → `event.session.work_changed` →
   `prompt.completed {promptId, reason}`. `agent.status.updated` interleaves
   throughout with `{model, thinkingEffort, contextTokens, maxContextTokens,
   usage:{byModel, total, currentTurn}}` or `{phase:{kind}}` variants.
9. **`:abort` timing**: REST ack `{aborted:true}` in ~15ms; `turn.ended
   {reason:"cancelled"}` ~30ms later. Clean two-phase-stop mapping.
10. **Queue auto-advance**: a queued prompt starts automatically
    (new `turn.started`) when the active turn ends — steer is an
    optimization, not required for queued prompts to run.
11. **Steer race pinned**: `prompts:steer` after the turn ended returns
    HTTP 200 with envelope `code:40402, msg:"no active prompt to steer
    into"` — the prompt stays queued and auto-runs; treat 40402 as benign.
12. **Approvals**: two frames per request as documented
    (`permission.approval.requested` rich display +
    `event.approval.requested` with `approval_id === tool_call_id`); dedupe
    by `approval_id`. `GET /sessions/{id}/approvals?status=pending` →
    `items[{approval_id, tool_name, action, tool_input_display,
    expires_at…}]`. `POST …/approvals/{id} {decision:"approved"}` →
    `{resolved:true}` + both `*.approval.resolved` frames.
13. **Fresh sessions have no model** (`agent_config.model === ""`), and
    `GET /config` exposes `default_model` — confirmed; always pass `model`
    on submit.

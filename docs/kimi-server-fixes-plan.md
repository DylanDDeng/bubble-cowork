# Kimi server runtime — audit fix plan (v2, panel-reviewed) — IMPLEMENTED

**Status (2026-07-19): implemented and verified.** All fixes below landed;
`verify:kimi-server` grew from 42 to 63 assertions (21 new suites), a new
`verify:kimi-queue-flush` covers F17, and the live E2E passes against the
real 0.27.0 CLI. Probe outcomes and implementation deviations are recorded
in the appendix at the bottom.

Fixes for the 2026-07-19 deep audit of the kimi app-server integration.
v2 incorporates a four-lens review panel (correctness / invariants / races /
coverage); every amendment below was verified against the tree at 40cab26.
Line numbers reference that tree.

Invariants this plan must uphold (from docs/kimi-server-adapter-plan.md):
(1) no failure-triggered runtime fallback — transient failures never flip a
thread between server and ACP; (2) never kill a daemon this process did not
spawn; (3) exactly one `result` per turn; (4) a still-valid session id is
never destroyed; (5) fail-closed permission routing; (6) the two-phase stop
gate never hangs.

## Phase 0 — before anything else

- **F18** `useKimiRuntimeStatus.ts:4`: add `serverAvailable: false` to
  `FALLBACK_STATUS`. One line, clears the only kimi tsc error — land first
  so typecheck stays green through the rest.
- **Probes** (extend `scripts/probe-kimi-server.mjs`; run during Phase 1 so
  their results gate Phase 2/3 items):
  1. `:abort` against a submitted-but-queued prompt (F10) — does it cancel?
     Is there a prompt-delete route? Does a stop drain the queue, or can a
     queued prompt auto-advance after an abort (F10/F11 blind spot)?
  2. Authoritative live-turn-state field on `GET /sessions/{id}` (F14).
  3. Logged-out daemon behavior (F6): does `kimi server run` fail at spawn
     or at turn time, and with what error shape?
  4. `offset` reset semantics for `assistant.delta` (F15): per-turn
     cumulative or per-assistant-segment? Plus how a streamed message
     correlates to its `GET /messages` row (multi-segment turns).
  5. Expired/already-resolved approval: response shape of a late
     `resolveApproval` (F13's 404 mapping is currently a guess).
  6. The real daemon-stop subcommand (`kimi server kill` per the pinned
     0.26.0 banner vs `kimi server stop`) — F3's remediation text must
     match the CLI.
  7. Dead-pidfile behavior: if the singleton refusal points at a dead
     pid/port, does a later `kimi server run` self-heal or refuse forever?
     (Determines whether F3's adoption-unhealthy case needs code or only
     messaging.)
  8. (informational) WS close shape after `rotate-token` (F9a re-reads
     unconditionally, so this only documents).
- **Harness seams** needed by later tests (mechanical, no behavior change):
  inject `execFile` into `isKimiServerCapable` and the runtime-status
  probes (F6/F7 tests); extract the ipc abort-and-respawn predicate into a
  pure module (F2 test); add a top-level-extras parameter to the L1 `push`
  frame helper (today it spreads extras into `payload`, but `offset` is a
  top-level frame field — without this the F15 test tests nothing).

## Phase 1 — daily-path breakage (P0)

### F1. Two-phase stop leaks the retired runner's listener → auto-denied approvals

**Defect.** `interruptAndSettle` (agent-loop.ts:167-191) never aborts the
runner's `abortController` and never detaches `handleEvent`; the ipc settle
path only does `runnerHandles.delete(sessionId)` (ipc-handlers.ts:10182).
The leaked listener stays live; when a replacement runner's
`permission_request` arrives, the leaked runner's `onPermissionRequest`
hits the stale-handle guard (ipc-handlers.ts:9760) and synchronously
REST-rejects the *live* pending approval — `respondToRequest` deletes the
adapter's pending interaction (kimi-server-adapter.ts:463), so the user's
real answer then hits the fail-closed drop. One user stop poisons every
later approval on that thread. Applies to codex too (shared two-phase
stop). Secondary: one leaked `service.events` listener per stop.

**Fix.**
- Add `detach()` to the runner handle: `abortController.abort();
  service.events.off('event', handleEvent);` — teardown *without* the
  `stopSession` side effect `abort()` carries (a second `stopSession`
  after settle would emit a spurious `stop_settled`).
- In the settle continuation, call `stopHandle.detach()`
  **unconditionally at the top** — the continuation has three exit paths
  (`isStopInitiator`, replacement-live, and currentEntry-already-deleted
  falling through to the idle write at :10191) and the old handle must be
  detached on all of them.
- Invariant: every removal from `runnerHandles` ends with `abort()` or
  `detach()`. The onError retirement at :9672 gets `detach()` (shared
  path for all providers — `abort()` there would fire `stopSession` on an
  errored-but-alive session and emit a spurious `stop_settled`). The
  respawn sites (:8829, :9631) keep `abort()` — replacement serialization
  depends on its `pendingSessionStops` publication. Document: `detach()`
  is only legal where a stop was already issued or the session is being
  handed to a respawn that re-stops.
- Close the adjacent pre-existing gap for free: `interruptAndSettle`'s
  `service.stopSession(threadId)` promise (agent-loop.ts:186) is never
  published to `pendingSessionStops`; when the safety net settles
  unconfirmed while the `:abort` REST call is still in transit, a
  replacement runner can resume the same session id and the late `:abort`
  kills its first turn. Publish it the same way `abort()` does.
- ~~WeakSet conversion~~ — dropped: `userStoppedRunnerHandles` is already
  a `WeakSet` at HEAD (ipc-handlers.ts:3424).

**Tests.** New L1 harness section driving compiled `startAgentLoop` +
provider service with an injected-transport facade (agent-loop is
Electron-free), the ipc stale-handle guard simulated in
`onPermissionRequest`: stop → settle → replacement → `permission_request`
→ assert the decision waits for the user and exactly one
`respondToRequest` reaches the adapter; assert
`service.events.listenerCount('event')` is flat across N stop/start
cycles. Codex-side assertion included (shared path). The ipc settle
continuation itself stays live-E2E-covered.

### F2. Mid-turn send with a changed model aborts the live kimi turn

**Defect.** The abort-and-respawn condition (ipc-handlers.ts:8804) has
`nextProvider === 'kimi' && modelChanged` with no mid-turn guard; codex
has `codexMidTurn` for exactly this.

**Fix.** `kimiMidTurn = nextProvider === 'kimi' && session.status ===
'running' && isServerProvenance(session)` — **scoped to server-runtime
threads** (`kimi_session_id` has the `server:` prefix, or id-less with the
F12 default currently 'server'). An unscoped status-only guard would also
exempt legacy ACP threads, routing a mid-turn send into
`KimiAcpAdapter.sendTurn` (no concurrent-prompt support) — the exact
defect F12 describes. No config is lost on the server path: the runtime
passes `model` per prompt (kimi-server-adapter.ts:347-366), so the
steered/queued prompt carries the new model natively. Semantic note
(differs from codex's "applies next turn"): a steered prompt can change
the *running* turn's model at submit — this is the desired behavior, not
an accident.

**Tests.** Extract the abort-and-respawn predicate into a pure module
(Phase 0 seam); L1 cases: server-provenance running + modelChanged → no
abort; legacy running + modelChanged → abort (unchanged behavior).

### F3. healthz failure leaks the owned daemon and wedges every retry

**Defect.** `startDaemon`'s two early failure paths kill the child, but a
`waitForHealthz` throw (kimi-server-manager.ts:352→390) propagates without
killing the owned child or setting state. Every retry then hits the CLI
singleton refusal, adopts the same wedged daemon, and fails — until the
user kills the process manually; on quit it is orphaned.

**Fix.** Wrap the post-ownership tail (`waitForHealthz` through
`this.state = state`) in try/catch: on failure, if `owned`, SIGTERM the
child, then rethrow. Adoption-unhealthy variant: keep the throw, make the
error actionable with pid/port and the real stop subcommand (probe 6 —
the pinned banner says `kimi server kill`, not `stop`). No auto-kill of
foreign processes (invariant 2). Probe 7 decides whether the dead-pidfile
loop needs more than messaging.

**Also fixed here (audit findings the v1 plan dropped):**
- **F3b — adoption race**: the spawned probe child's `exit` handler calls
  `handleDaemonExit(generation)` unconditionally (:284-289). On the
  adoption path the refused probe child *always* exits moments later; if
  that lands after `this.state = state` (:363), the generation matches and
  the freshly adopted healthy daemon is torn down. Disarm the handler once
  adoption is chosen: `let adopted = false` captured by the closure, set
  before the adoption `waitForHealthz`; handler body becomes
  `if (!adopted) this.handleDaemonExit(generation)`.
- **F3c — healthz-window conflation**: `exited ? 2_000 : readyTimeoutMs`
  (:352) gives an adopted daemon only a 2s window whenever the refused
  probe child exited first (the common case). Adopted daemons get
  `readyTimeoutMs`; the 2s shortcut applies only to owned children whose
  process died.

**Tests (L2).** Banner-yes/healthz-never spawn → child killed on failure;
second `startDaemon` spawns fresh. Adoption with a probe child whose exit
is delayed past state assignment → adopted daemon survives (F3b).
Adoption after probe-child exit gets the full healthz window (F3c;
needs a `delayed-healthz` fake behavior). Adoption-unhealthy → error text
carries pid/port + the probed subcommand.

### F4. A 30s request timeout is misclassified as daemon death

**Defect.** `requestOnState`'s catch (kimi-server-manager.ts:504-514) only
recognizes `state.abortController.signal.aborted`; a `TimeoutError` or a
transient socket error falls into the "daemon died" branch →
`handleDaemonExit` on a live daemon → every session torn down.

**Fix.** Classify before declaring death:
1. `state.abortController.signal.aborted` → `daemon_exit` (unchanged).
2. Timeout → throw `KimiServerTransportError('timeout', …)` for *this
   request only*. Detect via a kept reference to the timeout signal
   (`timeoutSignal.aborted`) rather than `error.name` — robust against
   undici wrapping.
3. Anything else → probe `GET /healthz` (2s, with
   `state.abortController.signal` in its abort set so a concurrent
   teardown cancels and reclassifies as `daemon_exit`): OK ⇒ transient,
   throw `http_error` for this request only; refused/failed ⇒
   `handleDaemonExit` as today. Concurrent classifiers are safe —
   `handleDaemonExit` is generation-guarded (:399).

**Tests.** L1 primary (injected fetch waiting on the request signal yields
a genuine `TimeoutError`): timeout → single-request failure, other
sessions untouched, next request fine; non-timeout error + healthy
healthz → no teardown; + one L2 smoke.

### F5. Quit racing an in-flight spawn leaks the daemon permanently

**Defect.** `killSync()`/`stop()` null the state and set `stopped`, but
`startDaemon` never rechecks `this.stopped`; a quit inside the ~15s spawn
window leaves the just-spawned child alive, and the next launch adopts it
as *unowned* so no future quit kills it either.

**Fix.** Two layers:
- Async: re-check `this.stopped` at each await barrier (banner poll loop,
  `waitForHealthz` loop, and — in the same synchronous run as the
  assignment — before `this.state = state`); when stopped, SIGTERM the
  owned child and throw `daemon_unavailable('manager stopped')`.
- Sync: the barrier checks run on future ticks, but `killSync` exists for
  before-quit where no further ticks are guaranteed. Track the in-flight
  child synchronously (`this.pendingSpawnChild = child` from spawn until
  ownership resolution / state assignment) and have `killSync()` SIGTERM
  it directly.

**Tests (L2).** `killSync()` during the healthz wait → child killed, start
promise rejects, `this.state` stays null. `killSync()` immediately after
spawn (banner window) → pendingSpawnChild killed synchronously.

### F5b. Session bound to a stale generation becomes a wedged thread (new — dropped in v1)

**Defect.** `startSession` captures `generation` right after the first
`ensureDaemon()` (kimi-server-adapter.ts:220), but `resolveResume` (:236)
and `createSession` (:245) can bounce the daemon (retries + warm-ups over
seconds; each inner `request()` transparently respawns). The session then
binds generation N on a generation-N+1 daemon: every `sendTurn` throws
`stale_generation` (:318) and `handleDaemonExit(N+1)` skips it (:1088) —
the thread errors on every send and is never cleaned up.

**Fix.** Bind `session.generation = this.manager.getGeneration()` *after*
the last awaited manager call, immediately before registering the session;
`sendTurn`'s stale-generation throw then reflects reality. (No
re-subscribe needed: a bounce during resume already re-runs subscription
via `resolveResume`'s own retries.)

**Tests (L1).** Injected transport bounces the daemon (generation++)
between `resolveResume` and session registration → first `sendTurn`
succeeds.

## Phase 2 — lifecycle, gating, routing, and the queue

### F6. Turn gating runs the ACP probe for server-runtime sessions

**Defect.** `ready = acpAvailable && authState === 'ready'`
(kimi-runtime-status.ts:164-165); `serverAvailable` is computed but never
consulted. Every turn start (ipc-handlers.ts:8283/8768) spawns
`kimi --version` + `kimi acp --help` (2.5s timeouts) and, when ACP looks
available, a 5s auth handshake — per turn, uncached.

**Fix.**
- `ready = cliAvailable && (serverAvailable || (acpAvailable && authState === 'ready'))`.
- Run the ACP auth probe only when `!serverAvailable`. Server-path login
  problems surface from the daemon/turn, mapped to the login message at
  the error boundary — probe 3 pins the shape first (spawn-time vs
  turn-time failure changes where the mapping lives). Note: legacy
  bare-id threads on a server-capable machine also skip the pre-turn
  login banner; acceptable (shared auth store), covered by a test.
- **Add a TTL cache to `getKimiRuntimeStatus` itself** (~10s), so turn
  starts stop paying repeated probe spawns on any path.
- `formatKimiRuntimeBlockingMessage`: server-path failures must not tell
  the user to fix "ACP".

**Tests (L1, via the Phase 0 execFile seam).** ready matrix (server-only,
acp-only+auth, neither); TTL cache hit; blocking-message routing.

### F7. Capability probe caches its first failure for the whole app run

**Defect.** `isKimiServerCapable` (kimi-adapter-facade.ts:53-70) caches
the first probe promise; a transient `execFile` timeout resolves `false`
forever (`forceReload` has no callers). Every later new thread silently
lands on ACP with a bare id — the runtime-flapping the facade's own
docblock forbids (invariant 1).

**Fix.** Split outcomes:
- Definitive (probe ran: clean exit with `run` in output, or clean
  "unknown subcommand" failure — distinguishable via `error.code`/
  `error.killed`/output text): cache for the app run.
- Indeterminate (ENOENT, timeout/killed, spawn error): do **not** cache;
  retry once; then **fail the session start loudly**
  (`daemon_unavailable`, "could not determine kimi server capability —
  retry") instead of silently creating an ACP thread. Loud-fail applies
  to the *start path only* — `getKimiRuntimeStatus`/status panel report
  indeterminate instead of throwing.
- Warm the probe at adapter registration (feeds F12's sync getter).

**Tests (L1, seam).** Transient failure → not cached → next call
re-probes; definitive false → cached; indeterminate after retry → start
throws, no ACP thread created.

### F8. Daemon death flips every idle session to error — and the fix must retire the zombie runner entry

**Defect.** `handleDaemonExit` (kimi-server-adapter.ts:1086-1104) emits an
`error` for every bound thread; the ipc idle silent-drop guard is
claude-only (:9625). One daemon restart ⇒ toast + DB error per open kimi
thread.

**Fix (two halves — the second is load-bearing).**
- Adapter: emit `error` (+ error result — see F14 wording) only for
  sessions with `activeTurn`; idle sessions finalize/dismiss/release with
  `status_change` only.
- ipc: the suppressed error was the **only** signal that retired the
  `runnerHandles` entry (:9672). Without replacement, the next send
  reuses the stale handle → facade `sendTurn` → "No Kimi session found"
  → error toast at send time with the message dropped — worse than the
  bug. Add to the continue path's respawn condition:
  `nextProvider === 'kimi' && !kimiAdapter.hasSession(threadId)` →
  detach-style teardown + fresh spawn (which resumes via the stored
  `kimi_session_id`, :8912). This also covers the idle-`session_gone`
  zombie (F14). The claude `inFlightTurns` silent-drop guard cannot be
  reused — kimi never increments it, so it would misclassify mid-turn
  entries.

**Tests (L2).** Daemon dies with one mid-turn + one idle session → error
surfaces only mid-turn; idle session's **next send succeeds without any
toast** (assert through the respawn path, not just adapter silence).

### F9. WS reconnect: stale token forever, and a lone `not_found` kills live threads

**Defects.** (a) Reconnect always uses `state.token`
(kimi-server-manager.ts:794-806); after `rotate-token` the WS loop 401s
forever — with no REST traffic mid-turn, streaming silently stops.
(b) The reconnect resubscribe ack emits `session_gone` per `not_found`
unconditionally (:964-966) — the trusted-lone-not_found class 40cab26
fixed for resume, alive on the reconnect path (bites adopted daemons
restarted externally: same port, lazy session registry). The same emit
site also fires spuriously during `resolveResume`'s own verification
subscribes.

**Fix.**
- (a) In the reconnect timer, before `connectWebSocket`: re-read the token
  file; if changed, update `state.token`. Unconditional, no 401-shape
  detection needed.
- (b) Extract `resolveResume`'s verify loop into a shared
  `verifySessionPresence` helper (subscribe → on not_found REST-check
  40401 twice, spaced, `GET /messages` warm-up between attempts —
  preserving the pinned lazy-registry and explicit-subscribe semantics).
  The reconnect ack no longer emits `session_gone` directly; it schedules
  `verifyGoneAndNotify(sessionId)` with a **verify ledger**:
  - one in-flight verify per session id (dedupe — reconnects flap);
  - a per-id epoch bumped by `unsubscribeSession` AND by any successful
    subscribe/`resolveResume`; the loop re-checks
    `subscriptions.has(id)` + its captured epoch before every attempt and
    before emitting `session_gone`;
  - generation-checked (a `daemon_exit` mid-verify aborts the loop);
  - never inserts into `subscriptions` (subscribe only if still
    registered) — no zombie registry entries.
  Single-session subscribe promises (`resolveResume` path) keep their
  current return semantics.

**Tests (L2; fake server needs `/__test/rotate-token`, session seeding,
a lazy-registry mode, and a `manual-turn` behavior so a turn can span the
drop).** Rotate + WS drop mid-turn → reconnect with fresh token, stream
resumes. External restart behind the same port with lazy registry → no
`session_gone`, thread stays bound; assert the outcome is epoch-change
resync reconciliation (a fresh daemon means a new epoch — not "gap
replayed"). Stale-verify race: session resumed by the adapter while a
verify is mid-loop → verify aborts, no `session_gone`.

### F10. Stop inside the submit window never reaches the server (prompt-keyed rework)

**Defect.** `stopSession` settles `noTurn: true` when `!session.activeTurn`
(:399) **and releases the session** (:1174) — but `activeTurn` is only set
by `turn.started` (:624). A stop after the REST submit ack (or during the
in-flight submit) releases the binding while the server generates
unattended into an unsubscribed session.

**Fix.** Not a boolean — the panel found two residual races in the
set-after-resolve version (a fast turn's terminal outruns the REST
response and sticks `activeTurn` true forever; a stop during the
in-flight submit still releases). Prompt-keyed bookkeeping instead:
- `session.pendingPrompts: Set<prompt_id-or-placeholder>` — a placeholder
  entry is added **before** awaiting `submitPrompt`, swapped for the real
  `prompt_id` on resolve, removed on `prompt.completed`/`prompt.aborted`/
  `turn.ended` (stop discarding those frames at :671-675).
- Effective turn-pending = `session.activeTurn || pendingPrompts.size > 0`;
  `stopSession` uses it to choose the `:abort` path.
- If the submit resolves and `this.sessions.get(threadId) !== session`
  (stop already released it), the continuation fires `:abort` (or the
  probe-1 prompt-delete route) itself — the server never generates
  unattended.
- Probe 1 also pins the queued-auto-advance case: whether a stop must
  drain queued prompts so one can't start *after* the abort (shared blind
  spot with F11).
- Steer semantics preserved: `wasActive` stays snapshotted before submit;
  the 40402 benign race handling is untouched.

**Tests (L1).** Stop between submit-ack and `turn.started` → `:abort`
issued. Stop during in-flight submit → continuation aborts after resolve.
Fast turn (terminal before REST resolve) → no stuck pending state; a
later stop settles `noTurn` instantly.

### F11. Stop racing natural completion hangs "stopping" then warns falsely

**Defect.** `handleTurnEnded` settles a pending stop only for `cancelled`/
`failed` (:883/:903); a `completed` terminal leaves it pending → 5s
"stopping" → `confirmed:false` → ipc prints "**Codex** did not confirm
the stop…" (also wrong provider, ipc-handlers.ts:10203).

**Fix.** In the `completed` branch, `settleStopIfPending(session, true)`.
Double-settle is impossible (`settleStop` clears `stopRequest` first, and
`releaseSession` unbinds the frame route, so a late `cancelled` frame is
dropped at the :617-620 lookup). Make the ipc warning provider-aware.

**Tests (L1).** Stop then `turn.ended {completed}` → settles confirmed
immediately, no warning appended; late `cancelled` frame → no second
settle.

### F12. Optimistic `kimiRuntime: 'server'` before the first id exists

**Defect.** Id-less sessions report `kimiRuntime: 'server'`
(ipc-handlers.ts:7961-7968) regardless of the capability probe; the
facade's `getComposerCapabilities` (:118-122) consults only the env
override. On an ACP-routed machine the steer UI is enabled for the first
turn → mid-turn send into `KimiAcpAdapter.sendTurn`.

**Fix.** Sync `getKimiDefaultRuntime(): 'server' | 'legacy'` on the
facade, backed by the warmed probe (F7) + env override; unresolved probe
reports `'legacy'` (safe: steer disabled until known; immediate send
still works). Use it in the session serializer and
`getComposerCapabilities`. **Push, don't poll**: when the warm probe
settles, re-broadcast the session list (or a runtime-changed event) so
already-rendered sessions pick up the real default — the serializer only
runs on list/get, and the id-less window can outlive the first render.

**Tests (L1, seam).** Getter matrix (probe pending/true/false × env
override); serializer uses the getter (via extracted predicate or E2E).

### F13. A failed approval REST call orphans the permission card

**Defect.** `respondToRequest` deletes the pending interaction *before*
awaiting the REST resolution (:463→486), no catch; on failure the user's
Allow does nothing and a second click hits the fail-closed drop.

**Fix (panel-corrected — the v1 "card stays actionable" was wrong: the
renderer card and ipc pending promise are consumed on the first click, so
a retained adapter entry alone has no retry path).**
- Add an in-flight latch: `pending.resolving = true` before the await;
  `respondToRequest` ignores further decisions for that entry while set
  (exactly one `resolveApproval` in flight — no concurrent approve/reject
  race).
- Delete the entry only on REST success.
- On REST failure: clear the latch, re-check
  `session.pendingInteractions.get(requestId) === pending` (a WS
  `approval.resolved` may have consumed it meanwhile — don't resurrect),
  then **re-emit the `permission_request` event with the same requestId**
  — it flows agent-loop → ipc → a fresh card and pending promise, and the
  retained adapter entry makes the retry land. Plus a local notice
  ("Approval didn't reach the Kimi server — answer again.").
- Probe 5 pins the expired-approval shape; map it to
  `permission_dismissed` + entry removal (with the same staleness
  re-check so a WS-resolved entry isn't double-dismissed).
- Same restructure for the question path.

**Tests.** Must cross the agent-loop boundary (the F1 harness section):
first `resolveApproval` rejects → a *second* `permission_request` reaches
the loop, second answer resolves once; double-click during flight →
single REST call; expired → dismissed once.

### F17. Queue auto-flush dies when the pane leaves the session (promoted from Phase 3)

**Defect.** The running→completed flush lives in a mounted `PromptInput`
effect (PromptInput.tsx:851-875); switching panes silences it — queued
messages sit unsent, a later Enter jumps the queue, reload drops them.
Shared surface with codex.

**Fix.** Move the trigger to a store-level subscriber on any session's
running→completed transition (useAppStore already computes the
transition, :2522; `takeAll`'s destructive read makes double-fire
benign). **Config semantics (panel-adjusted, codex-visible):** a flush
for the *mounted, focused* session keeps today's behavior (current
composer selection); a background flush sends without composer overrides
(session-sticky config). **The PromptInput effect is deleted in the same
change** — two flushers with different config semantics racing is worse
than either. `PromptInput` keeps only the chip UI. Queue persistence
across reloads stays a follow-up (localStorage, text+references only).

**Tests.** New renderer-level verify script (zustand vanilla in node,
precedent: verify:composer-agent-selection): background session
transition flushes in order; Enter after switching back doesn't preempt;
**codex cases included** (background codex flush uses sticky config;
foreground unchanged).

## Phase 3 — stream and transcript consistency

### F14. `session_gone`/resync can strand a turn on "running" forever

**Defect.** `handleSessionGone` (:1106-1122) emits no error event and no
result (agent-loop ignores `status_change`); `handleResync` (:1129-1157)
never settles a turn whose terminal fell inside an unreplayable gap. Both
leave the spinner until a manual Stop.

**Fix.**
- `handleSessionGone` with `activeTurn`: emit the `error` event (which
  settles the ipc turn via `onError`) **and** an error result — note this
  is *more* than the daemon-exit path emits today (that one has no
  result); align both while here. Idle: notice-only (F9's verification
  makes false `session_gone` rare; F8's `hasSession` respawn covers the
  zombie entry).
- `handleResync` with `activeTurn`: consult live turn state via probe 2's
  field. **Probe-gated, no watchdog** — the panel showed a
  no-frames watchdog can synthesize a result seconds before the real
  `turn.ended` of a quiet-but-alive turn (invariant 3 violation); if
  probe 2 yields no authoritative field, the fallback is "leave it
  running" (status quo), not a timer. After the async consult, re-check
  `this.sessions.get(threadId) === session && session.activeTurn` and
  that no `turn.started` intervened (queued prompts auto-advance) before
  synthesizing the success result + notice + `settleStopIfPending`.

**Tests.** L1 primary (emit `resync_required`/`session_gone` on the
injected transport + `state.messages`): gap-swallowed terminal → settles
once; consult racing a real `turn.ended` → exactly one result; mid-turn
session_gone → error result, session released; idle session_gone → notice
only, next send respawns (with F8). L2 smoke for the epoch-change path.

### F15. `assistant.delta` ignores `offset` — silent text holes after WS blips

**Defect.** `appendAssistantText` (:679-699) blindly concatenates; deltas
are volatile (never replayed), so a mid-turn WS drop persists a silently
holey message, and duplicated volatile frames double text.

**Fix (probe-gated on probe 4).**
- Compare `offset` against a **per-turn cumulative counter** (sum of
  finalized segment lengths + current segment) — `finalizeStreaming`
  splits assistant text into a new message at every `tool.call.started`
  (:757), so comparing against the current segment alone would misread
  every post-tool delta as a gap. If probe 4 says offset is per-segment,
  compare per-segment instead — the probe decides the counter, not the
  code.
- `offset < expected` → overlap: append only the tail beyond `expected`.
- `offset > expected` → gap: mark `session.textGapDetected`, keep
  streaming.
- On `turn.ended` with the flag: fetch authoritative text via
  `GET /messages` (probe 4 pins the streamed-uuid ↔ row correlation for
  multi-segment turns), re-emit final message(s) under the same uuid(s),
  and verify the downstream store upserts (not appends) for an
  already-finalized uuid before shipping.
- Volatile-frame cursor rules untouched (dedupe lives inside forwarded
  frames).

**Tests (L1, needs the Phase 0 top-level-extras push helper).** Dropped
middle delta → final text matches authoritative; duplicated delta → no
doubling; multi-segment turn with post-tool deltas → no spurious gap.

### F16. `failTurn`/manual-compact emit a second terminal into a running turn

**Defect.** A mid-turn (steer-path) submit failure calls `failTurn`
(:367-370 → :1262), emitting an error result + status error for the
*running* turn; the real `turn.ended` then emits a second terminal.
`/compact` mid-turn has the same shape via `handleHistoryCompacted`'s
synthetic result (:1066-1081).

**Fix (panel-corrected).** When `wasActive` and the submit fails: emit a
**local notice only** ("Your queued message wasn't submitted — send it
again."). **No `error` event** — the v1 plan's error event would reach
ipc `onError`, which flips the session to error, toasts, and deletes the
runner entry mid-stream (and post-F1 would detach the live runner) —
mutually destructive with F1 and a re-creation of the flicker this fix
targets. Explicitly accepted: the failed steer prompt is **not
re-queued**; its user-message row is already persisted and the notice
names the failure. `/compact` mid-turn: reject with a notice
("wait for the current turn to finish") — unprobed server semantics, and
the synthetic result must never race a live turn.

**Tests (L1, `failSubmit` fetch knob).** Steer submit fails mid-turn →
no result/error event, one terminal at real turn end, notice present.
`/compact` mid-turn → notice, no compact call.

## Phase 4 — small fixes and cleanups

- **F19** Thinking control for the "Default" model option
  (useComposerAgentSelection.ts:959-967): resolve
  `model || kimiModelConfig.defaultModel` before the entry lookup; the
  `kimiThinkingToSend` validity check uses the same effective model.
  (Known cosmetic edge: CLI-config default may differ from the server
  `GET /config` default.)
- **F20** No guessed tier: when `supportEfforts` exists but
  `defaultEffort` doesn't, check a synthetic "Default" row instead of
  `supportEfforts[last]` and omit the trigger-label suffix (:977-979).
- **F21** Orphan cleanup: on fresh-session subscribe refusal (:247-253),
  unsubscribe the registry entry and `:archive` the orphan server
  session; same unsubscribe-on-throw for the facade adoption pre-check
  (facade :160).
- **F22** Remove the hardcoded kimi model pins in the compatible-provider
  path — **three** sites: `useCompatibleProviderConfig.ts:59`,
  `CompatibleProviderSettings.tsx:91-92` (suggestion rows), and
  `getProviderModelPlaceholder` at `CompatibleProviderSettings.tsx:736-737`
  (the `'kimi-k2.5'` fallback the v1 plan missed). Free text + generic
  placeholder (empty default is precedented: deepseek ships `model: ''`).
- **F23** Delete the dead `ProvidersRuntimeStatusPanel.tsx` (no
  importers).

## Fake-server / harness additions (rollup)

`fake-kimi-server.mjs`: per-route latency + one-shot socket-destroy
(F4 smoke), `delayed-healthz` (F3c/F5), `/__test/rotate-token` (F9a),
session seeding + lazy-registry mode + `manual-turn` (F9b), epoch-bump /
forget-session (F14 smoke). `verify-kimi-server.mjs`: top-level frame
extras in `push` (F15), `failSubmit`/`failApprovalOnce`/`approvalExpired`
fetch knobs (F16/F13), the agent-loop harness section (F1/F13), execFile
seams (F6/F7/F12). New renderer verify script for F17.

## Sequencing

Phase 0 (F18 + probes kicked off + seams) → Phase 1 (F1, F2, F3/F3b/F3c,
F4, F5, F5b) → Phase 2 (F6, F7, F8, F9, F10, F11, F12, F13, F17) →
Phase 3 (F14, F15, F16) → Phase 4. Dependencies: F2 uses F12's default
for id-less rows (land the getter early or default id-less to legacy in
the predicate until F12 lands); F10/F14 gate on probes 1/2; F15 gates on
probe 4; F8's respawn check and F14's idle path land together. After each
phase: full `verify:kimi-server` + `npm test` + live
`verify-kimi-server-e2e.mjs`.

## Implementation appendix (2026-07-19)

### Probe outcomes (scripts/probe-kimi-server-v2.mjs, 0.27.0)

1. **`:abort` vs queued prompt**: a queued prompt **auto-advances into its
   own turn right after `:abort`** — a stop MUST drain the queue. The
   dequeue route is `POST /sessions/{id}/prompts/{pid}:cancel` (exists;
   `DELETE` 404s). Semantics on a *running* prompt unpinned → the stop path
   cancels tracked prompts AND belt-and-braces aborts.
2. **Live turn state**: `GET /sessions/{id}` carries `busy`,
   `main_turn_active`, `pending_interaction`, `last_turn_reason` — F14 keys
   off `main_turn_active`/`busy`.
3. **Logged-out daemon**: NOT probed (would require logging out the real
   account). Server-path auth errors pass through verbatim at turn time;
   the status panel keeps `loginCommand` visible. Revisit on first report.
4. **`offset` semantics**: **resets per assistant SEGMENT** (per message —
   zeroes after each tool-call boundary; within a segment offset ==
   cumulative segment length). `GET /messages` rows arrive newest-first as
   `{id, session_id, role, content, created_at}`; repair correlates
   segments to the turn's assistant rows by order and falls back to an
   honest notice on any mismatch.
5. **Expired/unknown approval resolution**: HTTP 200 + envelope
   `code 40404, msg "approval … not found"` → mapped to
   `permission_dismissed`.
6. **Daemon stop subcommand**: **`kimi server kill`** (there is no `stop`);
   remediation text uses it.
7. **Dead pidfile**: after SIGKILL of the daemon, the next
   `kimi server run` **self-heals** (no stale refusal) — the adoption-loop
   concern needs messaging only.
8. **rotate-token WS shape**: not needed — the reconnect loop re-reads the
   token file unconditionally.

### Deviations from the plan text

- **F2**: the abort-and-respawn predicate was NOT extracted into a pure
  module; `kimiMidTurn` (server-provenance-scoped) landed inline next to
  `codexMidTurn`. Covered by E2E + review, not a unit test.
- **F6**: implemented (capability-first ready + 10s TTL cache + ACP probe
  only for legacy-only machines), but without an execFile seam — no unit
  test; validated live (server-capable machine reports ready with
  `authState: 'unknown'`, no per-turn handshake).
- **F8**: the zombie-entry retirement is a `hasSession` pre-check in the
  continue path (`kimiSessionReleased`, scoped to non-running sessions so a
  mid-start window can't be misread as a zombie).
- **F10**: prompt-keyed bookkeeping is `pendingPromptIds` +
  `submitInFlight`; `turn.ended` clears the set wholesale (steered prompts
  merge into the turn; a queued prompt auto-advancing re-tracks itself via
  its ack). Residual accepted: a stop landing in the ~ms between
  `turn.ended(A)` and queued-B's `turn.started` can miss B.
- **F14**: probe-only (no watchdog), exactly as the panel amended.
- **F16**: the failed steer prompt is NOT re-queued — its user row is
  persisted and the notice says to resend.
- **F17**: instead of deleting the PromptInput effect, flush ownership is
  refcounted (`claimQueueFlushOwner`): the mounted composer keeps today's
  live-composer-config flush; the store-level watcher
  (`src/ui/lib/queue-auto-flush.ts`) covers ownerless sessions with
  session-sticky config. Queue persistence across reloads remains a
  follow-up.
- **F9b single-session reconnects**: `sendSubscribe` gained a
  `verifyOnNotFound` flag — reconnect resubscribes (any count) route
  not_found through `verifyGoneAndNotify`; caller-consumed subscribes keep
  promise semantics.
- **L2 additions were folded into L1**: the new races are exercised with
  injected transports (fresh-child spawners, scripted subscribe acks,
  signal-honoring fetches) rather than new fake-server behaviors; the
  existing L2 lifecycle suites still pass unchanged, and the live E2E
  covers the real daemon.

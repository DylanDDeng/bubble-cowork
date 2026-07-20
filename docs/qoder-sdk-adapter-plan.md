# Qoder SDK Adapter Plan (v2 — post-review, M0 complete)

Add Qoder as a seventh built-in agent provider, wrapping the official
`@qoder-ai/qoder-agent-sdk` (npm, verified 1.0.15) in a `ProviderAdapter`,
modeled on the pi adapter (pure SDK wrap, no process/daemon management — the
SDK spawns `qodercli` itself).

Status: **IMPLEMENTED — M0 + M1a + M1b landed** (2026-07-19). Reviewed by a
four-lens panel (architecture / registration-reality / SDK-protocol /
release-test): 4 × conditional pass, all conditions folded into this
revision. Full probe program run live against SDK 1.0.15 + qodercli 1.0.47
(P1–P8 plus extended P5-fix/P6c/P7r/P9–P12/P8b; results in the appendix).
M1a shipped: `qoder-sdk-loader.ts` (with `setQoderSdkForTests` seam),
`qoder-sdk-adapter.ts` (~1300 lines), full registration across
main/preload/UI, packaging exclusion, and `verify:qoder-sdk-adapter`
(6 wiring groups + 22 L1 behavioral checks with an injected fake SDK) in
the `npm test` chain. M1b shipped: warm `setModel`, context ring,
settings Runtime Health row, usage entries. Validation: full `npm test`
green, `vite build` green, and `scripts/verify-qoder-sdk-live.mjs` PASS
against the real qodercli 1.0.48 (the smoke caught and fixed a real
lazy-init deadlock: the SDK only initializes on the first user message,
so `startSession` dispatches the first turn BEFORE awaiting init).
Deviations from the v2 text: (1) no `qoder-settings.ts` — the model
catalog lives in the adapter and the `get-qoder-model-config` IPC serves
it directly; (2) the composer permission-mode control is deferred (the
qoderPermissionMode plumbing is complete end-to-end: payload → normalize
→ RunnerOptions → adapter); (3) `verify-git-branch-pill.mjs` and
`verify-subagent-workstream.mjs` needed pre-existing stale-assertion
fixes to keep the chain green.

## Why the SDK (and not ACP)

| | ACP | `@qoder-ai/qoder-agent-sdk` |
| --- | --- | --- |
| Process isolation | ✅ stdio child | ✅ SDK spawns qodercli as a child |
| Resume / fork / continue | ⚠️ resume-by-id only | ✅ verified live (P3/P4) |
| Multi-turn long session | — | ✅ one Query, queue-fed `AsyncIterable`, exactly one result per turn, stable session id (P9); interrupt-then-continue on the same Query works (P9b) |
| Mid-turn interrupt | ❌ (kill proc) | ✅ in streamInput mode: `q.interrupt()` resolves in ~2ms, turn settles in ~140ms with `result(error_during_execution, "Operation aborted")` (P9b). ⚠️ string mode: late (~26s), unmarked, can close the transport (P5/P5-fix) — we never use string mode for sessions |
| Interactive permissions | ACP permission req | ✅ `canUseTool` fires for classifier-blocked commands with full `suggestions` (P6c: `rm -rf` triggered it; benign commands like `echo` are auto-approved by the CLI's safety classifier without a callback, P6) |
| Model catalog / switch | ❌ | ✅ `initializationResult()` carries 14 models + commands/agents/skills/account (P7r); `getAvailableModels()` works post-init; `setModel()` verified mid-session (auto→ultimate, session id stable, P10) |
| Plan mode | — | ⚠️ start-time `options.permissionMode` only; runtime `setPermissionMode('plan')` errors in 1.0.15 ("unknown permission_mode: plan", P11) |
| Usage / context data | ❌ | ⚠️ token fields zero on assistant/stream/result for auto AND fixed models (P12) — only `context_usage_ratio` carries data |
| Message shape | ACP schema | ✅ Claude-SDK-shaped with full Anthropic event sequences (P2) |
| Steer (mid-turn injection) | — | ❌ `priority:'now'` does not steer: the message is queued, delivered after the turn ends, and forces a session re-init (P9c) |
| Skill discovery | — | ✅ ADAPTED: `listSkills` serves `initializationResult().skills` (`{name, description, source}`, no path → virtual `qoder://skill/<name>`); process cache warmed by session starts, cold path spawns a message-free throwaway Query (~7s, `initializationResult()` resolves without a user turn). Composer inserts `/name` — skills double as slash commands and the CLI expands them inside the turn (verified live with `/skill-creator`) |
| Extras | — | `generateSessionTitle`, `rewindFiles`, session-store APIs, hooks, plugins, subagents, `onAuthExpired` |

## Verified surface

### Behavior verified live (2026-07-19, full data in appendix)

- Basic: `system.init → assistant* → result.success`; init carries
  `session_id`, model, cli/protocol versions.
- Streaming: ordered Anthropic events (`message_start/content_block_* /
  message_delta/message_stop`).
- Resume by id (context provably retained); fork (new id, source intact).
- Same-Query multi-turn: per-turn results, exactly one each, stable
  session id (P9). Same-Query interrupt+continue (P9b).
- Mid-turn `priority:'now'` injection: queued, not steered; a second
  `system.init` (re-init, same session id) follows (P9c). Re-inits also
  follow `setModel` (P10) — the pump must tolerate them.
- Permissions: `canUseTool` fires for classifier-blocked commands;
  suggestions = `addRules(command)` + `setMode(acceptEdits)`; in `auto` /
  `dontAsk` modes a blocked command is silently skipped (no callback, no
  `permission_denied` message observed).
- Models: `initializationResult()` → `models[]` (14: auto/ultimate/
  performance/efficient/lite/qmodel*/kmodel*/gm51model/dmodel/dfmodel/
  mmodel — effectively all VL), `commands`, `agents`, `skills`, `account`
  (subscription type). `setModel` mid-session verified (modelUsage keys
  flip auto→ultimate; session id unchanged).
- Images: base64 image block understood by VL models (P8, P8b-on); no
  enabled non-VL model exists in the catalog to force a negative (P8b-off
  skipped).
- Usage: token fields are zero on assistant messages, stream events, and
  results, for `auto` and for a fixed named model (P12a/b).
  `context_usage_ratio` present on every result.
- Auth failure (pre-login baseline): no init;
  `result(error_during_execution)` with `terminal_reason:"auth_required"`;
  CLI exits code 41; iterator throws.

### From official docs + installed `.d.ts` (contract)

- `query({prompt, options})` → async iterator; prompt = string (one-shot)
  or `AsyncIterable<SDKUserMessage>` (multi-turn; messages support
  `priority: 'now'|'next'|'later'`).
- Session control: `resume`, `continue`, `forkSession`, caller-chosen
  `sessionId`. Lifecycle: `q.interrupt()`, `q.close()`, `abortController`.
- Permissions: `canUseTool(toolName, input, {toolUseID, signal,
  suggestions, title, decisionReason, …})` → allow `{updatedInput?,
  updatedPermissions?}` / deny `{message (required), interrupt?}`.
  `permissionMode`: `default | acceptEdits | bypassPermissions | yolo |
  plan | dontAsk | auto` (options-level verified for default/auto/
  dontAsk). The CLI safety classifier can approve/deny without
  `canUseTool` (`classifier_approvable`, `decision_reason_type`).
- Models: fixed `options.model` or dynamic `resolveModel(context)` (13
  purposes; BYOK; no silent fallback). `ModelInfo.isVl/context_config/
  thinking_config`, `maxInputTokens`, `availableContextWindows`.
- MCP: `options.mcpServers`; per-tool `permission_policy` only on
  http/sse configs. MCP OAuth must complete before first `streamInput`.
- Query methods: `interrupt, close, setPermissionMode, setModel,
  getAvailableModels, getContextUsage, getUsageInfo, accountInfo,
  generateSessionTitle, addDirectories, rewindFiles, mcpServerStatus,
  supportedCommands, supportedAgents, listPlugins, initializationResult
  (carries models/commands/agents/skills/account), streamInput`; option
  callback `onAuthExpired` (fires at most once per session).
- Standalone session-store functions: `listSessions, getSessionInfo,
  getSessionMessages, forkSession, renameSession, tagSession,
  listSubagents`.
- Result: `SDKResultSuccess{result, duration_ms, num_turns, stop_reason,
  total_cost_usd, usage{…, context_usage_ratio}, modelUsage,
  permission_denials[]}`; `SDKResultError.errors: string[]`, subtypes
  `error_during_execution | error_max_turns | error_max_budget_usd |
  error_max_structured_output_retries`. Interrupt produces
  `error_during_execution` with `errors:["Operation aborted"]` (P9b).
- `SDKMessage`: 24 variants — assistant/user(+replay)/result/stream_event
  /`system.init|status|compact_boundary|api_retry|permission_denied|
  session_state_changed|hook_*|task_*`/prompt_suggestion/
  cloud_agent_event.

### Packaging reality (measured)

- The SDK bundles a 100MB `dist/_bundled/qodercli` (postinstall downloads
  the host-arch binary; `QODER_CLI_PLATFORM`/`QODER_SKIP_DOWNLOAD` knobs).
  Resolution order: `pathToQoderCLIExecutable` → `QODERCLI_PATH` →
  bundled → `.bin` → PATH.
- Repo precedent (claude SDK): electron-builder `files` excludes
  SDK-bundled binaries; production requires the machine's own CLI. We
  follow it.

## Architecture

```
src/electron/libs/provider/
  qoder-sdk-loader.ts   — dynamic SDK import + setQoderSdkForTests() seam
                          (day-one constraint; kimi-loader pattern, NOT pi's
                          seam-less loader)
  qoder-sdk-adapter.ts  — ProviderAdapter: one Query per thread, queue-fed
                          never-returning AsyncIterable prompt
src/electron/libs/
  qoder-settings.ts     — model/auth config surface (pi-settings pattern)
```

(`probeQoder` goes inline in `agent-runtime-directory.ts` like `probePi`;
settings-page runtime status rides the existing directory IPC, no separate
`qoder-runtime-status.ts` at launch.)

### Session lifecycle — stopSession IS the binding-release point (review B1)

There is no separate "teardown" hook in `ProviderAdapter`:
`service.stopSession` calls `directory.remove(threadId)` immediately after
the adapter resolves. Pi-style single-phase:

1. `q.interrupt()`;
2. wait up to ~2s for the in-flight turn's terminal result (P9b: ~140ms
   typical in streamInput mode; translate it as the turn's stopped
   result) — on timeout, synthesize a stopped result;
3. dismiss pending permission requests (`permission_dismissed`);
4. `q.close()`; `sessions.delete(threadId)`; emit `status_change:
   stopped`.

We do **not** emit `stop_settled` and do **not** extend
`isTwoPhaseStopProvider` (`ipc-handlers.ts:3441`) — the streamInput-mode
interrupt settles fast enough that two-phase buys nothing.

### Turn-terminal invariant (review M1)

Exactly one `result` StreamMessage per dispatched turn, enforced by a
per-turn `resultEmitted` guard in the pump:

- Normal: translate the SDK `result` (success or error subtype —
  interrupts arrive as `error_during_execution`/"Operation aborted" and
  map to the stopped result).
- Iterator ends or throws without a result (CLI crash, exit 41, transport
  drop): the pump synthesizes `result(subtype 'error')` for the
  in-flight turn. Never leave the IPC FIFO (`pendingTurnPrompts`) skewed.
- `SDKAssistantMessage.error` never terminates a turn; never synthesize
  from it.
- After stopSession step 2, any late SDK result is swallowed by the
  guard.

### SDKMessage → StreamMessage translation table (review M2)

| SDKMessage | StreamMessage action |
| --- | --- |
| `assistant` | `assistant`; map `parent_tool_use_id` → `parentToolUseId` (subagent rendering + IPC/store exemptions depend on it); pass `message.usage` |
| `user` (tool_result) | pass through as `user` |
| `user` echo / `isReplay: true` | **drop** — we already synthesize the user_prompt echo at enqueue; resume replays must not re-render the transcript |
| `stream_event` | narrow to `content_block_start/delta/stop` with text/thinking/signature deltas only |
| `result` | `result`; `modelUsage` passthrough (structurally identical to `ClaudeModelUsage`); context ring = `usage.context_usage_ratio` × current model context window; token fields are zero — do not emit `token_usage` |
| `system.init` (first) | emit `system_init` (session_id + model); stash models/commands for the catalog cache |
| `system.init` (re-init, same session id — after `setModel` or a queued mid-turn injection) | **not a new session**: refresh catalog/model/permission-mode caches; emit no transcript message |
| `system.status` (`compacting`) | compact notice |
| `system.compact_boundary` | compact boundary message |
| `system.permission_denied` | local notice (codex `emitLocalNotice` pattern) |
| `system.api_retry` | local notice |
| `prompt_suggestion`, `system.hook_*`, `system.task_*`, `cloud_agent_event`, `session_state_changed` | drop at launch (debug log) |

### sendTurn / queue model

The prompt is a queue-backed `AsyncIterable` that **never returns**
(return = stdin EOF = CLI exit = session death); it only ends via
`q.close()`. `sendTurn` pushes one `SDKUserMessage` and returns
immediately (codex-style ack). qoder is **not** added to
`canSteerWhileRunning` (`PromptInput.tsx:450`): P9c proves
`priority:'now'` cannot steer (queues + forces a re-init), so the queue
is ≤1 deep by construction. Architecture validated by P9/P9b.

**Lazy init (found by the live smoke):** the SDK initializes the CLI only
when the first user message arrives — an idle iterable yields no
`system.init` at all (verified: none after 12s). `startSession` therefore
pushes the first turn into the queue BEFORE awaiting init; awaiting init
first deadlocks. The L1 fake emits init eagerly, so this only surfaced in
`scripts/verify-qoder-sdk-live.mjs` (PASS vs real qodercli 1.0.48:
init → 2 turns with context continuity → 14-model catalog → clean stop;
context ring live: 15674/128000 tokens).

### Permissions

`canUseTool` → emit `permission_request` with `requestId = toolUseID`;
`respondToRequest` resolves the pending promise: allow (`updatedInput`
passthrough; "always allow this session" → `updatedPermissions:
options.suggestions`), deny (`message` required by the SDK — default
"Denied by user"; pass through `interrupt?: boolean`). Dismiss all
pending (emit `permission_dismissed`) on stop, close, and iterator
end/throw — a dead CLI must never strand an approval card. No
`AcpPermissionInput` changes: qoder rides the standard approval flow like
pi/codex. Coverage caveat: benign commands are auto-approved by the CLI
classifier without a callback (P6); blocked/risky commands do fire
(P6c); `auto`/`dontAsk` modes skip blocked commands silently.

### Auth & runtime detection

- `qodercliAuth()` default (reuse `qodercli login` state in `~/.qoder`);
  `QODER_PERSONAL_ACCESS_TOKEN` honored when set.
- Two failure entries, one UX: startup `auth_required`/exit-41 **and**
  mid-session `onAuthExpired` both map to the existing `login_required`
  runtime state ("Run `qodercli login`") and invalidate the cached probe.
  Settings probe = file-existence check like `probePi`; **never**
  `accountInfo()` (spawns a CLI per call).
- Executable: production resolves the machine's `qodercli` only (user
  requirement: Qoder installed locally, same as Claude/Codex/OpenCode);
  bundled binary is a dev-only convenience.
  `ProtocolVersionMismatchError` surfaces as an actionable "upgrade
  qodercli" error.
- Multi-instance/double-binding: adapter refuses to bind a qoder session
  id already bound to another live thread (codex
  `CodexThreadBindingError` pattern).

### Model catalog & switching

The catalog comes from `initializationResult()` at session start (P7r;
`getAvailableModels()` inside the init callback fails with "Transport
closed"). Because the CLI inits lazily, the picker would otherwise be
empty until the first session boots — and `useQoderModelConfig` only
fetches on mount. Shipped solution: the adapter emits
`model_catalog_updated` (**with a `provider: 'qoder'` discriminator** —
the event's codex consumer stays untouched, resolving review B2) whenever
the catalog changes; the IPC layer persists it to
`userData/qoder-model-catalog.json` and broadcasts
`qoder.modelConfigUpdated` → `useAppStore` dispatches
`qoder-model-config-updated` → the hook refetches. The
`get-qoder-model-config` IPC serves adapter cache → disk cache → empty
fallback, so the picker has the full list from the second launch onward
and updates live after the first session boot.

`sessionModelSwitch` capability: **true** — P10 verifies warm `setModel`
between turns (session id stable; re-init follows, handled per the
translation table). qoder is NOT in the `ipc-handlers.ts:8848`
respawn-on-model-change list; switches flow through `sendTurn →
adapter.setModel`. Mid-turn `setModel` is untested and not offered.
`planMode`: start-time `options.permissionMode:'plan'` only; runtime
`setPermissionMode('plan')` is broken in 1.0.15 (P11) — the UI must not
offer a runtime plan toggle for qoder. Verify the options-level `plan`
path on first run (P6 verified default/auto/dontAsk only).

### Usage / context ring

Context ring: `context_usage_ratio` (present on every result) × current
model's context window (`initializationResult` model metadata) →
absolute tokens for the composer indicator (claude-family context
snapshot branch). Token usage is zero on every message type for every
model tested (P12) — `token_usage` messages are not emitted; revisit on
an SDK upgrade (canary asserts it).

### runOneShot

Isolated threadId (`:oneshot:` suffix, pi pattern). Title generation
prefers `generateSessionTitle` on a thread's live Query; string-mode
one-shot is the fallback. Known cosmetic issue: one-shots litter the
qoder session store (no delete API) — accepted, documented.

### Packaging (review B2/M5)

- `electron-builder.json` `files`: exclude `**/node_modules/@qoder-ai/
  qoder-agent-sdk/dist/_bundled/**` (same precedent as the claude
  platform packages). DMG size impact ≈ 0; production always uses the
  machine CLI.
- Dev: bundled binary allowed (default SDK resolution).
- `scripts/probe-qoder-sdk.mjs` canary runs **both** executable paths
  (machine `qodercli` via `pathToQoderCLIExecutable`, and
  default/bundled) so version drift is caught in dev.

## Registration checklist (review-verified; UI is NOT typechecked by the

build — this list, not the compiler, is the authority)

Types/enums: `provider/types.ts` `ProviderKind` +
`ProviderSessionStartInput`/`ProviderSendTurnInput`
(`qoderPermissionMode?`); `shared/types.ts` `AgentProvider` (both
unions) + `QoderPermissionMode` type; `provider/service.ts`
`isProviderKind`.

Electron main: `agent-loop.ts` `registerAdapter(new QoderSdkAdapter())`
+ arg forwarding; `agent-runtime-directory.ts` `PROVIDER_META` +
`probeQoder` (login-state via file existence); `ipc-handlers.ts` —
display label (:1579), provider param union (:3357), source label
`qoder_local` (:7941-7951), start-session branch (:8142-8315),
switch-provider/model branch incl. resume-column pick (:8583-9027,
:8956-8961), per-provider start handling (:9204-9209), arg normalization
(:9047, :9868-9870), config-drift respawn list (:8848 — qoder added,
pi-style), permission-mode send chain (:9558-9563 pattern),
`get-qoder-model-config` handler; bridge chain `preload.cts` →
`src/types.d.ts` → `src/ui/types.ts`; `electron/types.ts` `SessionRow`
(+ provider inline union).

Persistence (`session-store.ts`): `qoder_session_id` column +
`ensureColumn` migration; `updateQoderSessionId`/`setQoderSessionId`;
`updateSessionProvider` union; `normalizeAutomationProvider` (decision:
exclude qoder from automations at launch — matches AutomationsView);
`getSessionSourceOrigin` (:758-786); search-index source map
(:1023-1036); `USAGE_PROVIDER_MODEL_FALLBACK` (:3074-3078).

UI: `ui/utils/provider.ts` (`PROVIDERS` + preferred whitelist);
`ProviderPicker.tsx` (icon + QoderLogo asset, PiLogo pattern);
`onboarding/AgentOnboardingView.tsx` `PROVIDER_LOGOS`;
`useAgentReadiness.ts` `PROVIDER_ORDER`; `useComposerAgentSelection.ts`
(build/resolve/persist branches) + new `useQoderModelConfig.ts`;
`ComposerAgentControls.tsx`; `AgentModelPicker.tsx`;
`NewSessionView.tsx` (decision: yes — planMode ✅ implies the
permission-mode param); `ChatPane.tsx`; `PromptInput.tsx`
(permission-mode control + context snapshot branch :388-437; **not**
`canSteerWhileRunning`); `useAppStore.ts` MCP-status provider whitelist
(:2851-2859) + streaming-hold branch (:253-270);
`settings/ClaudeUsageSettings.tsx` `USAGE_PROVIDERS` + model→logo map;
settings section for CLI status/auth guidance (M1b);
`ui/lib/wechatMarkdown.ts` runtime union. Terminal launcher
(`SessionTerminal.tsx`/`shared/terminal.ts`): **excluded at launch**
(product decision; pi/kimi are also absent).

Tests (same commit as the enum change!):
`scripts/verify-pi-sdk-adapter.mjs:70` asserts the exact `AgentProvider`
union string — update it or `npm test` goes red. Do not copy that
assertion style into the qoder script.

## Failure modes

- **CLI crash mid-turn** (iterator ends/throws): synthesize error result
  (invariant), dismiss pending permissions, release the binding so the
  next send rebuilds via `resume`, visible error notice.
- **Auth expiry mid-session**: `onAuthExpired` → `login_required`
  surface + probe-cache invalidation.
- **Protocol version mismatch** (machine CLI drift): loud actionable
  error; dev fallback = bundled binary.
- **Double binding**: one-owner guard rejects re-binding a live session
  id.
- **Interrupt latency**: streamInput-mode interrupt settles in ~140ms
  (P9b); stopSession still force-settles on a 2s timeout for safety.

## Milestones

- **M0 — probes: COMPLETE** (2026-07-19). P1–P8 + P5-fix/P6c/P7r/P9/P9b/
  P9c/P10/P11/P12/P8b run live; results in the appendix. Canary promoted
  to `scripts/probe-qoder-sdk.mjs` (`QODER_PROBE_EXECUTABLE` pins the
  machine CLI; run both paths after any SDK/CLI upgrade).
- **M1a — core adapter: LANDED** (2026-07-19). Loader (with test seam) +
  adapter (stream, thinking, tool traces, approvals, resume, fork,
  interrupt, queue model, lifecycle/invariant per this plan) + full
  registration + packaging exclusion + `verify:qoder-sdk-adapter.mjs`
  (6 wiring groups + 22 L1 checks, fake-SDK injection,
  `verify-kimi-server.mjs` style) in the `npm test` chain. L1 scenarios
  covered: turn-terminal invariant (incl. crash synthesis + abort
  mapping), stop teardown ordering, permission route/deny-default-message,
  replay filtering, `parent_tool_use_id` mapping, re-init tolerance,
  auth_required mapping, fork id, resume passthrough, runOneShot.
  Deferred inside M1a: composer permission-mode control (plumbing is
  complete), options-level `plan` first-run smoke.
- **M1b — surfaces: LANDED** (2026-07-19). Model catalog IPC +
  `useQoderModelConfig` (M1a), context ring in the composer (M1a), warm
  `setModel` between turns (qoder is NOT in the `ipc-handlers.ts:8848`
  respawn-on-model-change list — switches flow through
  `sendTurn → adapter.setModel`, P10-verified), settings Runtime Health
  row for Qoder (CLI/login state via the shared runtime directory probe),
  usage-settings entries (M1a).
- **M2 — hardening**: live smoke script LANDED
  (`scripts/verify-qoder-sdk-live.mjs`, PASS vs qodercli 1.0.48) + README
  provider list + steer/automations/terminal decisions (steer: dead per
  P9c; automations/terminal: excluded at launch). Remaining follow-up:
  L2 (`scripts/fake-qodercli.mjs` protocol harness for crash/exit-41/
  mismatch) — deferred; the seam is already covered by L1 (fake SDK) and
  the live smoke (real CLI), so L2 mostly duplicates proof.

## Appendix: live probe results

### P1–P8 (2026-07-19, SDK 1.0.15, bundled qodercli 1.0.47, protocol 1.0.0)

| Probe | Verdict | Key evidence |
| --- | --- | --- |
| P1 basic | PASS | `init→assistant→assistant→result.success`; tokens 0, `context_usage_ratio` 0.12 |
| P2 streaming | PASS | full Anthropic event sequence |
| P3 resume | PASS | same session_id; prior context recalled |
| P4 fork | PASS | new session_id; source untouched |
| P5 interrupt (string mode) | PASS (caveats) | fired at 2s; stream continued ~26s; `result.success/end_turn`, no marker |
| P5b post-interrupt resume | PASS | new query + resume: session alive |
| P6a/P6b canUseTool (echo) | FAIL (expected) | never fired — classifier auto-approved `echo` |
| P7 getAvailableModels in init cb | FAIL (timing) | "Transport closed" inside init callback |
| P8 image | PASS | base64 image understood ("Red") via auto |

### Extended probes (same build)

| Probe | Verdict | Key evidence |
| --- | --- | --- |
| P5-fix interrupt timing (string mode) | FAIL | "Transport closed" after interrupt post-stream-start — string-mode interrupt is unusable; irrelevant to the adapter (streamInput only) |
| P6c-allow canUseTool(`rm -rf`) | PASS | callback fired; full args incl. `toolUseID`, `suggestions` (`addRules(command)` + `setMode(acceptEdits)`); command executed after allow |
| P6c-deny | INCONCLUSIVE | model never attempted the command that run (variance); deny path unobserved |
| P6c auto / dontAsk | PASS (documented) | blocked command silently skipped; no callback, no `permission_denied` |
| P7r catalog timing | PASS | `initializationResult()` OK — 14 models + commands/agents/skills/account; `getAvailableModels()` OK post-init |
| P9 same-Query multi-turn | PASS | 2 turns → exactly 1 result each; same session id |
| P9b same-Query interrupt+continue | PASS | interrupt resolve 2ms; `result(error_during_execution, "Operation aborted")` 140ms later; next turn runs on the same Query |
| P9c `priority:'now'` mid-turn | PASS (negative) | no steer — message queued, delivered post-turn, session re-init follows |
| P10 setModel mid-session | PASS | auto→ultimate (modelUsage keys flip); session id unchanged; re-init follows |
| P11 setPermissionMode | PARTIAL | `setPermissionMode('plan')` → "unknown permission_mode: plan" (1.0.15 bug); other modes OK; plan not entered |
| P12 usage dump | PASS (negative) | tokens zero on assistant/stream/result for auto AND fixed `ultimate`; only `context_usage_ratio` real |
| P8b image VL control | PASS | no enabled non-VL model in catalog (off skipped); isVl model understood image |

Artifacts: `dev-fixtures/qoder-m0/probe.mjs` (P1–P8), `probe2.mjs`
(extended), `probe-report.json`, `probe-report-2.json`,
`auth-error-evidence.json` (pre-login baseline).

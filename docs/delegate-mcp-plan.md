# Cross-agent delegation via the Aegis delegate MCP server

Status: design finalized 2026-08-09. All open policy decisions are settled; this
document is the reference for implementation.

## Goal

Let the lead agent of any session hand a task to a different agent
("have Kimi review this", "ask Codex to double-check the migration") through an
ordinary, visible tool call — with the sub-agent's trace rendered exactly like a
Claude Code subagent: a capsule row in the main transcript that opens the
SubagentPanel on the right.

Explicitly out of scope (lessons from the removed auto fan-out, `94f5583`):
no automatic task routing, no team/orchestration layer, no delegation without a
visible tool call in the lead's turn.

## Architecture summary

Aegis exposes a **delegate MCP server** to the CLIs it hosts. The core tool is
`delegate_task(agent, prompt, ...)`. When called, the main process runs the
target agent itself and **mirrors its message stream into the parent session's
transcript**, tagged with `parentToolUseId` = the delegate tool call's id.

### Execution model (the settled compromise)

- There is **no user-visible child session**. The UI never shows a second
  conversation.
- The main process still allocates an internal execution session row (hidden;
  `hidden_from_threads` already exists) because the entire execution pipeline —
  `runnerHandles`, permission routing, event routing via session↔threadId maps,
  stop, worktree assignment — is keyed by session id. Reusing it avoids building
  a parallel "session-lite" container.
- The hidden session's runner does **not** persist messages under its own id.
  Every event is mirrored into the **parent session's stream** with
  `parentToolUseId`, plus a per-message `provider` tag (the renderer currently
  assumes one provider per session; avatars/icons must come from the message,
  not the session).
- Consequences we get for free: SubagentPanel + capsule grouping + turn-card
  attribution (the `parentToolUseId` filter already exists), stop cascade
  (stopping the parent stops every runner attached to it), transcript
  persistence and reload, and permission prompts surfacing in the parent
  composer.

### Transport and auth

- **Claude leads**: in-process injection via `createSdkMcpServer`
  (precedent: `src/electron/libs/memory-mcp.ts`). The per-runner closure carries
  the parent session id — attribution is trivial.
- **All other CLIs**: the main process hosts a **streamable-HTTP MCP server**
  bound to loopback (`127.0.0.1`), authenticated with a **per-install bearer
  token**. stdio is impossible: those CLIs are child processes that cannot
  reach into the Electron main process, and codex/kimi/opencode are singleton
  daemons sharing one MCP connection across sessions.
- The HTTP entry is written into each CLI's global config (the
  `codex-mcp-settings` field-destruction bug that blocked writing HTTP entries
  is fixed — `verify:codex-mcp-settings`). When a CLI runs outside Aegis the
  connection is refused fast; verify per CLI that a dead HTTP server does not
  stall startup.

### Caller attribution (hardest problem; v1 scope cut)

The HTTP server must map an incoming `delegate_task` call to the parent session
(to know where to mirror, which tool_use anchors the capsule, and how to enforce
depth limits).

- **Claude**: solved by construction (in-process, per-runner closure).
- **codex**: when codex invokes an MCP tool, the thread's event stream first
  emits the corresponding `mcpToolCall` item carrying tool name + arguments.
  On receiving an HTTP call, match `(tool name + argument hash)` against
  pending `mcpToolCall` items across running codex sessions. A collision
  (identical concurrent arguments) is astronomically unlikely; on collision,
  reject and let the model retry with a nonce argument.
- **kimi / opencode / qoder / bubble**: unverified whether their event streams
  expose MCP call arguments. **v1 ships with Claude and codex as leads only**;
  enable others one by one after verifying attribution.

Any agent can be the **target** in v1 (it's just a runner the main process
starts).

### Depth limit

Hard limit: **one level**. No chained delegation. Because singleton CLI daemons
share MCP connections, the limit cannot be structural (e.g. "don't inject the
server into child runners") — it is enforced **server-side**: if the attributed
caller session is itself a hidden delegate execution session, the call is
rejected with an explanatory error.

### Blocking call + timeout policy

v1 uses a **plain blocking tool call**. All timeout knobs are under Aegis's
control:

- Claude: `MCP_TOOL_TIMEOUT` env set by the runner at spawn.
- codex: `tool_timeout_sec` in `config.toml` (writable now).

Set them generously (~30 min) for the delegate server. The spawn+poll two-phase
design (which would turn the lead's loop into polling) is a **fallback only**,
applied per-CLI if some CLI's timeout proves uncontrollable.

### Permissions — DECIDED

The delegated sub-agent **inherits the parent session's permission mode
directly**. If the parent runs bypass/acceptEdits, the sub-agent runs the same
mode with no extra prompts. If the parent mode requires prompting, the
sub-agent's permission requests surface in the **parent composer, labeled with
the target agent** (natural behavior of the mirror model — requests broadcast
per session and the parent is the live one).

### Concurrency protection — DECIDED

**Steer is locked while a delegation is in flight.** The composer rejects
steer-while-running for the parent session while any delegate call is pending,
so "lead blocked on tool call = single writer in the working directory" holds.
Worktree isolation (`isolation: "worktree"`-style flag on `delegate_task`, plus
apply/discard UI, plus its "forks from HEAD, can't see uncommitted changes"
caveat) is deferred to v2; v1 always shares the parent's working directory.

### Hidden-session side effects

The internal execution session must suppress: title generation
(`skipTitleGeneration`), system notifications, branch-naming LLM calls, and
anything else that assumes a user-facing session.

### Result summarization

The tool result returned to the lead is bounded: the sub-agent's **last
assistant message + the list of change records, truncated**. Finer-grained
summarization is deferred.

### Turn-card / changes attribution

Follows the subagent rules shipped in `183bc69`: the parent turn card counts
only the lead's own edits; the delegate's edits appear as a changes card inside
its SubagentPanel. `isSessionEffectivelyBusy` / `isSubagentTaskBlock` must
recognize the delegate MCP tool call (match by MCP tool name) so the composer
stays in the stopped style and the capsule renders with the target agent's
avatar.

### v1 exclusions

- Automation (scheduled) sessions may not call `delegate_task`.
- No Grok/Pi leads or targets until verified.
- No worktree isolation (v2).
- No chained delegation (permanent, not just v1).

## Implementation order

1. ~~Fix `codex-mcp-settings.ts` field destruction~~ — done, `b9d0b04`,
   `verify:codex-mcp-settings`.
2. **Zero-protocol "diff handoff" first**: cross-provider transcript copy
   (near `ipc-handlers.ts` transcript-copy code, ~:5163) + `turn_changes` git
   patch groundwork already exists. Ships user value with no MCP work and
   exercises the cross-provider summary format.
3. Delegate MCP server: in-process (Claude) + HTTP (codex) transports, bearer
   token, attribution matcher, depth guard, mirror pipeline, capsule/predicate
   recognition, hidden-session side-effect suppression.
4. Observe real usage; then consider more leads, worktree isolation, async
   two-phase calls.

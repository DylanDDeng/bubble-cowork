# Claude native Goal integration

Aegis reuses the existing Goal composer, status row, editor tab, replacement dialog,
and sent-message styling for Claude tasks. Claude Code executes `/goal` itself;
Aegis does not implement a model continuation loop or add an MCP tool.

## Runtime contract

Verified with the installed Claude Code 2.1.266 and Agent SDK 0.3.220:

- `supportedCommands()` must advertise `goal` before a goal is dispatched.
- `/goal <condition>` creates Claude's session-scoped prompt Stop hook and starts
  work. Native local-command output acknowledges activation.
- `/goal clear` removes the hook without an inference request. Internal control
  messages and their zero-turn results are omitted from Aegis chat/accounting.
- Claude checks the condition before stopping. A failed check continues inside
  Claude. A completed condition auto-clears inside Claude.
- This local SDK stream does not reliably emit `active_goal`. An SDK
  `UserPromptSubmit` callback supplies the authoritative `transcript_path`.
  A read-only incremental observer consumes native `goal_status` attachments.
  It ignores historical baseline rows, subagents, malformed rows and duplicate
  UUIDs. Polling runs only while a goal is active.
- The live controls use native evaluation counts and status. Completion shows
  the native `durationMs` as `Goal achieved in …` in the completed turn's assistant
  action row, with checks and reason in its tooltip. The entire row shares the
  copy button's hover/focus reveal and fade, respecting reduced motion. The completion is stored in
  chat history and never follows the composer into a later turn. The UI does not
  expose a Codex token budget or invent Claude's unavailable budget accounting.

## Pause, resume and restart

Claude has no native persisted paused status. Aegis pauses by interrupting the
current work, waiting for stopped turns to drain, and confirming `/goal clear`.
It saves the goal text and paused status under its own userData/claude-goals.
Resume submits a new native `/goal` and restarts Claude's evaluation count.

The normal Stop button follows the same goal cleanup path. A native SDK failure
while interrupting a queued turn closes the owned process; explicit Goal
controls can reopen it for a local clear only. They do not retry inference.
A runner resuming a task with Aegis Goal state (including an unacknowledged
set) performs a hidden `/goal clear` before accepting user prompts, so reopening a task or sending an ordinary message cannot silently
reactivate an old Goal. An interrupted active goal is shown paused after restart
and requires explicit resume. Completed goals remain as a completion summary.

Mutations are serialized per Aegis task. A set operation awaits the native
acknowledgement; an unsupported runtime, hook-policy rejection or failed start
surfaces an error. A timed-out set terminates its owned runtime to prevent a
late activation after the caller has already received failure.

## Configuration and long goals

The integration does not write Claude settings, global hooks or MCP configuration.
Its SDK callback exists only in the owned process. Claude continues to enforce
its native permission and managed-hook policies.

Claude limits a condition to 4000 UTF-16 units. Longer objectives are stored in
private app-owned files scoped to the Aegis task. The native condition references
that file; the UI keeps the full text. Only Read of that exact generated goal
file is auto-approved. Other files keep the existing permission behavior.

## Validation

- `npm run verify:claude-goal`: persistence, session isolation, queued stopping,
  hidden control responses, long-goal read scope and unsupported runtimes.
- `npm run verify:claude-goal-native`: real installed CLI and Agent SDK against a
  loopback fake model, with an isolated credential-free configuration directory.
  Covers unmet-to-met native continuation, pause, queued-stop failure recovery,
  restart without inference, ordinary follow-up, resume, clear, long objectives,
  and native hook-policy rejection. No paid model behavior is evaluated.
- `npm run verify:session-goal`: real production React components rendered in an
  isolated Electron window with a mocked bridge. Exercises Codex and Claude
  composers, Goal controls, editor, themes and session isolation.
- Existing Claude stop/cancellation, latency, Plan and Codex Goal checks remain
  part of regression validation.

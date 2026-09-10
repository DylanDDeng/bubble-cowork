# Native Codex Goal integration

Reference inspected on 2026-09-09: installed Codex App 26.901.51231, its `app.asar` renderer and generated app-server protocol; verified against codex-cli 0.153.2. This is a native Codex Provider feature. Other providers retain their own slash-command behavior, including Grok's existing `/goal` command.

## Interaction

- `/goal` selects a pending Goal mode in both the new-task and existing-task composers. It removes the command token, exits Plan, shows a Goal pill and objective placeholder, and waits for Send.
- A compact row above the composer uses the server's six Goal statuses, objective, elapsed time or token usage/budget. Hover/focus reveals clear, pause/resume and edit actions. Budget-limited/completed goals have no ordinary Resume action.
- Edit opens the existing right utility workspace as a Goal tab; chat makes room for it. The editor supports Save, Revert, Cmd/Ctrl+Enter and Escape, and closes if another objective replaces its source.
- Replacing an unfinished goal asks for confirmation. Cold runtime resumption of a paused, blocked or usage-limited goal offers Resume / Keep paused (or Not now). Merely opening a saved task reads its goal without resuming its native thread.
- Stop pauses native continuation before interrupting the current turn, including the gap between turns. If pausing fails, the owned runtime is stopped and the failure is surfaced; the saved server goal may still be active.
- A completed goal is cleared in the background and disappears from the composer. Its native completion time places `Goal achieved in …` in the corresponding assistant reply's action row, matching Codex's `completedThreadGoalTurnKey` routing. The completion and copy button fade in together on reply hover or keyboard focus, and fade out when both leave; reduced motion disables the transition. A durable `goal_completed` history record preserves it across later turns, replacement, Clear and restart. A replacement is serialized against automatic clearing.

## Runtime contract

The app calls `thread/goal/get`, `thread/goal/set`, and `thread/goal/clear`, and handles `thread/goal/updated` / `thread/goal/cleared`. Before activation, `thread/settings/update` commits the model, native reasoning effort, permissions, Default collaboration mode and service tier. If the picker has no effort override, the effective effort from thread creation/resumption is preserved.

Autonomous turns come from app-server notifications. Aegis does not submit a second `turn/start` or manufacture a continuation loop. Ordinary follow-ups remain ordinary turns, and authentication recovery cannot replay a prior Goal creation action. Goal mutations use a separate awaited desktop IPC boundary; they do not add MCP tools or write the user's Codex/other-agent configuration.

The native server owns status, budgets and counters. The UI does not infer a budget from prose or create a default budget. Goals over 4,000 Unicode codepoints are stored as private, app-owned text files and sent as references; the editor expands only trusted app-generated references. Definitive RPC rejection removes its new file; uncertain transport failure retains it because the server might already have saved the reference.

## Validation

- `npm run verify:codex-goal`: production manager/adapter tests and IPC lifecycle tests with controlled runtime responses; covers native settings, autonomous stream separation, stopping, one-shot activation, Unicode/file references, cold control, transcript persistence, stale reads, errors and completion/replacement races.
- `npm run verify:session-goal`: production composers, Goal editor and right utility workspace rendered in Electron with a mocked bridge and isolated profile. Exercises slash selection, submission, normal follow-ups, pause/resume, edit/revert/save, replacement confirmation, cold-resume confirmation, session isolation, light/dark themes and narrow width. `QA_REDUCED=1` tests reduced motion; `QA_CAPTURE=output/session-goal` captures screenshots.
- `npm run verify:codex-goal-native`: real installed CLI, temporary credential-free `CODEX_HOME`, paused persistent thread. Verifies native settings/get/set/clear and unloaded control without an inference turn. Requires a Goal-capable `codex` on PATH, or `AEGIS_TEST_CODEX_BINARY`.
- Existing Codex app-server checks, composer selection, Plan slash, utility panel state, icon imports, theme variables, both TypeScript builds and whitespace checks were also run.

Real model-driven pursuit through completion is not covered by the credential-free smoke test. The Electron test replaces the model bridge; it does not modify real user conversations or leave a development app running.

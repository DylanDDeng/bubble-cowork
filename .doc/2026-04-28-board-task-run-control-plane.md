# Aegis Board: Local Task and Agent Run Control Plane

Date: 2026-04-28

## Summary

Aegis Board should evolve from a session kanban into a local-first task and agent-run control plane.

The goal is not to build a full issue tracker, a GitHub client, or a Multica-style team platform. The first useful version should help a single operator manage local AI work: create a task, run one or more agents against it, inspect the output, and accept or reject the result.

The core product shape:

- Task is the work item.
- Run is one agent execution attempt for that task.
- Session remains the transcript and runtime stream backing a run.
- GitHub, Linear, Notion, or Markdown tasks are optional external sources, not the primary data model.

## Product Direction

Current Board behavior is session-centric: each card is a session, grouped by status or runtime, with a details panel that shows activity and lets the user continue a session.

The proposed direction is task-centric:

- A board card represents a task.
- A task may have zero, one, or many runs.
- A run may use Claude, Codex, OpenCode, or future providers.
- A successful agent exit moves the task to review, not directly to done.
- The user accepts a run result before the task becomes done.

This preserves Aegis as a local desktop workspace instead of turning it into a hosted project-management system.

## Inspiration

### Multica

Multica is useful as a product reference because it separates issues, agents, runtimes, comments, and execution history. The lesson for Aegis is the object model, not the full platform scope.

Borrow:

- Task/issue as the durable work object.
- Runs as execution history.
- Agent identity and runtime metadata on every run.
- Progress and blockers visible from the board.

Do not borrow yet:

- Multi-user workspaces.
- Cloud-first daemon registration.
- Full issue/project/permission system.
- Mandatory external tracker integration.

### Symphony

Symphony is useful because it is intentionally smaller. It treats the orchestrator as a long-running service that reads work, creates an isolated workspace, launches a coding agent, and exposes observability.

Borrow:

- Isolated workspace per autonomous task.
- In-repo workflow contract such as `.aegis/WORKFLOW.md`.
- Runtime status and observability before rich project-management UI.
- Completed agent run can end at a human-review state.

Do not borrow yet:

- Mandatory Linear polling.
- Fully unattended daemon loop.
- Complex scheduler/retry machinery as a v1 requirement.

## Goals

- Make concurrent agent work visible and manageable.
- Let users compare multiple runs for the same task.
- Keep Aegis local-first and tracker-agnostic.
- Separate execution status from human review status.
- Preserve the current chat/session model while adding a task layer above it.
- Avoid a large backend rewrite in the first phase.

## Non-Goals

- Build a full GitHub Issues replacement.
- Require GitHub or Linear to use Board.
- Add multi-user roles or permissions.
- Build a generic workflow engine.
- Add dependency graphs or agent-to-agent chaining in v1.
- Replace the normal chat workflow.

## Core Concepts

### Task

A durable local work item controlled by Aegis.

Suggested fields:

```ts
type TaskSource = 'local' | 'github' | 'linear' | 'markdown';

type TaskStatus =
  | 'todo'
  | 'running'
  | 'needs_review'
  | 'done'
  | 'cancelled';

interface Task {
  id: string;
  source: TaskSource;
  externalId?: string;
  externalUrl?: string;
  title: string;
  description?: string;
  status: TaskStatus;
  cwd?: string;
  branch?: string;
  labels: string[];
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  acceptedRunId?: string;
  createdAt: number;
  updatedAt: number;
}
```

### Run

One agent execution attempt against a task.

```ts
type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_permission'
  | 'completed'
  | 'failed'
  | 'cancelled';

interface AgentRun {
  id: string;
  taskId: string;
  sessionId: string;
  provider: 'claude' | 'codex' | 'opencode';
  model?: string;
  workspaceMode: 'current_cwd' | 'isolated';
  workspacePath?: string;
  status: RunStatus;
  startedAt: number;
  completedAt?: number;
  lastEventSummary?: string;
  changedFilesCount?: number;
  artifactCount?: number;
  testStatus?: 'unknown' | 'passed' | 'failed';
}
```

### Session

The existing transcript/runtime object. A run points to a session instead of replacing it.

This keeps the first implementation smaller:

- Existing session start/continue behavior can remain.
- Existing `SessionView` can back run details.
- Existing message timeline and artifact extraction can be reused.

## UX Model

### Board Columns

Initial columns:

- Todo
- Running
- Needs Review
- Done
- Cancelled

The important semantic change is that completed agent execution should move the task to `Needs Review`, not `Done`.

### Task Card

Each card should show:

- Title
- Project folder
- Current task status
- Latest run provider/model
- Run status
- Elapsed time or relative update time
- Changed file count
- Artifact count
- Test status, if known
- Permission/blocker indicator

The card should optimize for scanning active work, not reading chat summaries.

### Details Panel

Replace the single timeline-style detail panel with tabs:

- Runs: list all runs for the task, provider/model/status/duration, with the selected run linked to its session.
- Activity: human notes, agent summaries, blocker messages, and the current transcript summary.
- Changes: changed files, diff summary, test status, and accept/reject controls.
- Artifacts: generated files, previews, documents, or browser artifacts.

For v1, `Activity`, `Changes`, and `Artifacts` can be backed by existing session data and existing utilities. They do not need complete new storage on day one.

### Primary Actions

- New Task
- Run with Claude
- Run with Codex
- Run with OpenCode
- Retry Run
- Review Result
- Accept Run
- Reject Run
- Open Thread

The common flow:

1. User creates a task or converts a chat into a task.
2. User starts one run.
3. Agent completes.
4. Task moves to Needs Review.
5. User inspects changes/artifacts.
6. User accepts the run and task moves to Done.

## Workflow Contract

Add optional project-local workflow configuration later:

```text
.aegis/WORKFLOW.md
```

Purpose:

- Define default run prompt.
- Define default provider/model.
- Define whether autonomous board runs should use isolated workspaces.
- Define setup/validation hooks.
- Define required proof of work.

Example:

```md
---
agent:
  default_provider: codex
  max_turns: 12
workspace:
  mode: isolated
hooks:
  before_run: npm install
  validate: npm run build
review:
  completed_status: needs_review
---

You are working on an Aegis task.

Use the current task title and description as the source of truth.
Before finishing, report changed files, validation commands, and blockers.
```

This should stay optional. Aegis must work without it.

## Implementation Phases

### Phase 1: Local Task Layer

Create local task storage and adapt Board to render tasks.

Scope:

- Add task and run types.
- Add SQLite tables or equivalent local persistence.
- Add create/update/list APIs through Electron IPC.
- Add a task board view that can coexist with the current session board during migration.
- Let a task point at existing sessions/runs.

Minimum success criteria:

- User can create a local task.
- User can start a run from a task.
- The run creates or reuses a session.
- The task shows latest run status.

### Phase 2: Review-Centered Run Completion

Change completion semantics.

Scope:

- Completed run updates run status to `completed`.
- Parent task moves to `needs_review`, not `done`.
- Add Accept Run and Reject Run actions.
- Accepting a run sets `acceptedRunId` and moves task to `done`.
- Rejecting keeps the task in `todo` or `needs_review` depending on user choice.

Minimum success criteria:

- A completed agent run no longer silently marks work as done.
- The user has an explicit review/accept step.

### Phase 3: Details Panel Tabs

Make the board useful for inspection.

Scope:

- Add Runs tab.
- Add Changes tab backed by existing change/diff utilities where possible.
- Add Artifacts tab backed by existing artifact extraction.
- Keep Open Thread available for full transcript inspection.

Minimum success criteria:

- User can inspect what a run did without leaving Board.
- User can jump into the session when deeper context is needed.

### Phase 4: Isolated Workspace Mode

Add safer autonomous execution.

Scope:

- Add workspace mode to run creation.
- Start with `current_cwd` as default.
- Add `isolated` mode using git worktree or a temporary workspace.
- Surface workspace path on the run.
- Make changed files and adoption explicit before merging into the main project.

Minimum success criteria:

- Board-started autonomous runs can be isolated from the active working tree.
- The user can review changes before adopting them.

Implementation note, 2026-04-28:

- Board runs can now use `workspace.mode: isolated` from `.aegis/WORKFLOW.md`, or the UI's Isolated worktree option.
- Isolated runs create a git worktree under the app user-data workspace and store its branch/path on the run.
- `hooks.before_run` runs before the agent session starts.
- `hooks.validate` runs after a successful agent result and records validation status on the run.
- Accepting an isolated run applies changed files back to the base project only when those target paths have no local conflicts.

### Phase 5: Optional External Links

Add tracker integration without making it foundational.

Scope:

- Add `externalUrl` and `externalId` on tasks.
- Support linking a GitHub issue manually.
- Later support importing GitHub/Linear tasks.
- Later support creating PRs from accepted runs.

Minimum success criteria:

- GitHub/Linear are adapters, not required dependencies.

## Migration Strategy

The current Board is session-based. Avoid a hard rewrite.

Recommended path:

1. Keep the current session board behavior available during development.
2. Add a task model in parallel.
3. For existing sessions, create lightweight virtual tasks only when needed.
4. New Board-created work creates real tasks.
5. Once task board covers core workflows, retire or hide pure session board mode.

This keeps implementation risk lower and avoids breaking existing chat flows.

## Data Storage Notes

Aegis already persists sessions locally. The task/run layer can be added locally without external services.

Suggested tables:

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT,
  external_url TEXT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  cwd TEXT,
  branch TEXT,
  labels_json TEXT NOT NULL DEFAULT '[]',
  priority TEXT,
  accepted_run_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  workspace_mode TEXT NOT NULL,
  workspace_path TEXT,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  last_event_summary TEXT,
  changed_files_count INTEGER,
  artifact_count INTEGER,
  test_status TEXT,
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);
```

## Risks

- Scope creep into a full issue tracker.
- Confusing task status with run status.
- Making GitHub/Linear required too early.
- Breaking existing session-centered chat workflows.
- Adding isolated workspaces before review/adoption semantics are clear.

Mitigations:

- Keep v1 local-only.
- Keep GitHub as an optional link field.
- Treat task and run as separate state machines.
- Reuse existing session and artifact infrastructure.
- Add isolated workspace mode after review flow exists.

## Recommended First Implementation Cut

The first implementation cut should be deliberately small:

1. Add local `Task` and `AgentRun` persistence.
2. Add Board task cards with status columns.
3. Let `New Run` create a task and a session-backed run.
4. On successful run completion, move task to `Needs Review`.
5. Add Accept Run to move task to `Done`.

Do not implement in the first cut:

- GitHub import.
- Linear integration.
- Agent profiles.
- Dependency graphs.
- Scheduled autopilot.
- Isolated workspaces.
- Skill extraction.

Those become natural follow-ups after the local task/run model is stable.

## Open Questions

- Should tasks live in the global Aegis database only, or optionally in `.aegis/tasks.json` per project?
- Should existing sessions be auto-wrapped into tasks, or only new Board-created work?
- Should `Needs Review` replace the existing `needs-review` status ID or map to it?
- Should isolated workspace use git worktree first, or a plain copy/temp directory first?
- What is the minimal changed-files signal we can compute reliably across Claude, Codex, and OpenCode runs?

## Decision

Proceed with a local-first task/run control plane.

Do not build a GitHub-bound issue tracker. Do not build a Multica-style hosted platform. Use Symphony's smaller lesson: orchestrated runs need isolation, observability, and human review, while the UI can remain lightweight.

# Claude Runtime Health Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a Claude runtime health check with install/login guidance so users can see whether Claude Code is ready before starting a session.

**Architecture:** The Electron main process will expose a `getClaudeRuntimeStatus()` probe that inspects the bundled Claude runtime, reads auth state, and builds actionable guidance. The React UI will reuse that status in the new-session composer and Providers settings, and Claude session start/continue will run a preflight gate before invoking the runner.

**Tech Stack:** Electron, React 19, TypeScript, Claude Agent SDK CLI

---

### Task 1: Shared status contract

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/ui/types.ts`
- Modify: `src/types.d.ts`

**Step 1: Define Claude runtime health types**

Add shared types for:
- status kind (`ready`, `login_required`, `install_required`, `error`)
- auth source/details
- version / CLI path
- summary / detail / install and login commands

**Step 2: Thread the type through UI declarations**

Expose the new type via UI re-exports and `window.electron`.

### Task 2: Main-process runtime probe

**Files:**
- Create: `src/electron/libs/claude-runtime-status.ts`
- Modify: `src/electron/ipc-handlers.ts`
- Modify: `src/electron/preload.cts`

**Step 1: Add a small command runner around the bundled Claude CLI**

Implement:
- version check
- `auth status` parsing
- install/login guidance generation

**Step 2: Expose the result through IPC**

Add `get-claude-runtime-status` and preload bridge.

### Task 3: UI surfacing

**Files:**
- Create: `src/ui/hooks/useClaudeRuntimeStatus.ts`
- Create: `src/ui/components/ClaudeRuntimeStatusCard.tsx`
- Modify: `src/ui/components/NewSessionView.tsx`
- Modify: `src/ui/components/settings/CompatibleProviderSettings.tsx`

**Step 1: Load status once and refresh on demand**

Provide a hook that loads runtime status, caches local state, and supports manual refresh.

**Step 2: Show status and guidance**

Render:
- ready state
- missing runtime/install guidance
- missing auth/login guidance
- copyable commands and context notes

### Task 4: Preflight guard

**Files:**
- Modify: `src/electron/ipc-handlers.ts`

**Step 1: Gate Claude start/continue**

Before `runClaude`, check if the runtime is missing or auth is required for Anthropic models. If it fails, broadcast a clear error and skip runner startup.

### Task 5: Verification

**Files:**
- Modify as needed after checks

**Step 1: Run project build**

Run: `npm run build`

Expected: TypeScript + Vite build succeed without new errors.

**Step 2: Fix any type or lint regressions found during build**

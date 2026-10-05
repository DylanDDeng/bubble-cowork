import type {
  BubblePermissionMode,
  ClaudePermissionMode,
  CodexPermissionMode,
  DeepseekPermissionMode,
  DevinPermissionMode,
  KimiPermissionMode,
  OpenCodePermissionMode,
  QoderPermissionMode,
} from '../types';

/**
 * One permission-mode picker for every provider. The per-provider pickers were
 * six structurally identical components differing only in their mode list,
 * labels and warn styling — that difference now lives in the option maps
 * below, and the component itself is provider-agnostic.
 *
 * Option semantics:
 * - `tone: 'full-access'` renders the orange trigger with the shield icon
 *   (bypass/full-access modes); `tone: 'danger'` renders the red trigger
 *   without an icon (kimi's YOLO).
 * - `hidden: true` keeps the mode resolvable for the trigger label but out of
 *   the menu — plan modes that enter via /plan and exit via their pill.
 */
export interface PermissionModeOption<M extends string> {
  mode: M;
  label: string;
  tone?: 'full-access' | 'danger';
  hidden?: boolean;
}

// Plan enters via /plan and shows as a separate pill, so it is hidden from
// the menu but still resolvable while active.
export const CLAUDE_PERMISSION_MODE_OPTIONS: ReadonlyArray<PermissionModeOption<ClaudePermissionMode>> = [
  { mode: 'default', label: 'Default' },
  { mode: 'plan', label: 'Plan', hidden: true },
  { mode: 'auto', label: 'Auto' },
  { mode: 'acceptEdits', label: 'Accept Edits' },
  { mode: 'dontAsk', label: "Don't Ask" },
  { mode: 'bypassPermissions', label: 'Full Access', tone: 'full-access' },
];

export const CODEX_PERMISSION_MODE_OPTIONS: ReadonlyArray<PermissionModeOption<CodexPermissionMode>> = [
  { mode: 'defaultPermissions', label: 'Default' },
  { mode: 'auto', label: 'Auto' },
  { mode: 'fullAccess', label: 'Full Access', tone: 'full-access' },
];

export const OPENCODE_PERMISSION_MODE_OPTIONS: ReadonlyArray<PermissionModeOption<OpenCodePermissionMode>> = [
  { mode: 'defaultPermissions', label: 'Default' },
  { mode: 'plan', label: 'Plan' },
  { mode: 'fullAccess', label: 'Full Access', tone: 'full-access' },
];

// Shared by kimi and grok (grok rides the kimi mode state end to end).
export const KIMI_PERMISSION_MODE_OPTIONS: ReadonlyArray<PermissionModeOption<KimiPermissionMode>> = [
  { mode: 'default', label: 'Default' },
  { mode: 'plan', label: 'Plan' },
  { mode: 'auto', label: 'Auto' },
  { mode: 'yolo', label: 'YOLO', tone: 'danger' },
];

// Mirrors the qoder-agent-sdk `PermissionMode` union (verified 1.0.15).
export const QODER_PERMISSION_MODE_OPTIONS: ReadonlyArray<PermissionModeOption<QoderPermissionMode>> = [
  { mode: 'default', label: 'Default' },
  { mode: 'plan', label: 'Plan' },
  { mode: 'auto', label: 'Auto' },
  { mode: 'acceptEdits', label: 'Accept Edits' },
  { mode: 'dontAsk', label: "Don't Ask" },
  { mode: 'yolo', label: 'YOLO', tone: 'full-access' },
  { mode: 'bypassPermissions', label: 'Full Access', tone: 'full-access' },
];

// Like claude: plan is /plan + pill, not a menu entry.
export const BUBBLE_PERMISSION_MODE_OPTIONS: ReadonlyArray<PermissionModeOption<BubblePermissionMode>> = [
  { mode: 'default', label: 'Default' },
  { mode: 'plan', label: 'Plan', hidden: true },
  { mode: 'bypassPermissions', label: 'Full Access', tone: 'full-access' },
];

// dsh pins the sandbox mode via env at runtime spawn; switching respawns the
// runtime through the ipc config-drift path.
export const DEEPSEEK_PERMISSION_MODE_OPTIONS: ReadonlyArray<PermissionModeOption<DeepseekPermissionMode>> = [
  { mode: 'workspace-write', label: 'Default' },
  { mode: 'danger-full-access', label: 'Full Access', tone: 'full-access' },
];

// Devin ACP session modes; applied live via session/set_mode before each turn.
export const DEVIN_PERMISSION_MODE_OPTIONS: ReadonlyArray<PermissionModeOption<DevinPermissionMode>> = [
  { mode: 'accept-edits', label: 'Accept Edits' },
  { mode: 'smart', label: 'Smart' },
  { mode: 'ask', label: 'Ask' },
  { mode: 'plan', label: 'Plan' },
  { mode: 'bypass', label: 'Full Access', tone: 'full-access' },
];

import { useState } from 'react';
import type {
  BubblePermissionMode,
  ClaudePermissionMode,
  CodexPermissionMode,
  DeepseekPermissionMode,
  KimiPermissionMode,
  OpenCodePermissionMode,
  QoderPermissionMode,
} from '../types';
import { FullAccessPermissionIcon } from './FullAccessPermissionIcon';

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

export function PermissionModePicker<M extends string>({
  value,
  options,
  onChange,
  disabled,
  menuSide = 'top',
  menuMinWidthClass = 'min-w-[152px]',
}: {
  value: M;
  options: ReadonlyArray<PermissionModeOption<M>>;
  onChange: (mode: M) => void;
  disabled?: boolean;
  /** Which side the menu opens toward. Bottom-anchored composers open 'top'
   * (default); the centered new-thread landing passes 'bottom'. */
  menuSide?: 'top' | 'bottom';
  menuMinWidthClass?: string;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((option) => option.mode === value);
  const tone = current?.tone;

  return (
    <div className="relative no-drag">
      <button
        type="button"
        onClick={() => setOpen((currentOpen) => !currentOpen)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`inline-flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-[12px] font-medium transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-50 ${
          tone === 'full-access'
            ? 'text-[#E97E4F] hover:text-[#D96E42]'
            : tone === 'danger'
              ? 'text-[#b42318] hover:text-[#991b1b]'
              : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
        }`}
      >
        {tone === 'full-access' ? (
          <FullAccessPermissionIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
        ) : null}
        <span>{current?.label ?? value}</span>
      </button>

      {open && !disabled && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            className={`popover-surface absolute left-0 z-20 flex ${menuMinWidthClass} flex-col p-1 ${
              menuSide === 'bottom' ? 'top-full mt-2' : 'bottom-full mb-2'
            }`}
          >
            {options
              .filter((option) => !option.hidden)
              .map((option) => (
                <PermissionModeOptionRow
                  key={option.mode}
                  option={option}
                  active={option.mode === value}
                  onSelect={(nextMode) => {
                    onChange(nextMode);
                    setOpen(false);
                  }}
                />
              ))}
          </div>
        </>
      )}
    </div>
  );
}

function PermissionModeOptionRow<M extends string>({
  option,
  active,
  onSelect,
}: {
  option: PermissionModeOption<M>;
  active: boolean;
  onSelect: (mode: M) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(option.mode)}
      className={`rounded-lg px-3 py-1.5 text-left text-[13px] transition-colors ${
        active
          ? 'bg-[var(--bg-tertiary)] font-semibold text-[var(--text-primary)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
      }`}
    >
      <span className="truncate">{option.label}</span>
    </button>
  );
}

// ── Per-provider mode maps ──────────────────────────────────────────────────
// The single source for what each provider's picker offers. Ordered least →
// most permissive, mirroring each provider's own mode union.

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

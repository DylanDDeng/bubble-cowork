import { useState } from 'react';
import type { QoderPermissionMode } from '../types';
import { FullAccessPermissionIcon } from './FullAccessPermissionIcon';

// Mirrors the qoder-agent-sdk `PermissionMode` union (verified 1.0.15);
// ordered like the Claude picker, least → most permissive.
const QODER_PERMISSION_MODES: QoderPermissionMode[] = [
  'default',
  'plan',
  'auto',
  'acceptEdits',
  'dontAsk',
  'yolo',
  'bypassPermissions',
];

function isFullAccess(mode: QoderPermissionMode): boolean {
  return mode === 'bypassPermissions' || mode === 'yolo';
}

export function QoderPermissionModePicker({
  value,
  onChange,
  disabled,
  menuSide = 'top',
}: {
  value: QoderPermissionMode;
  onChange: (mode: QoderPermissionMode) => void;
  disabled?: boolean;
  /** Which side the menu opens toward. Bottom-anchored composers open 'top'
   * (default); the centered new-thread landing passes 'bottom'. */
  menuSide?: 'top' | 'bottom';
}) {
  const [open, setOpen] = useState(false);
  const current = MODE_META[value];

  return (
    <div className="relative no-drag">
      <button
        type="button"
        onClick={() => setOpen((currentOpen) => !currentOpen)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`inline-flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-[12px] font-medium transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-50 ${
          isFullAccess(value)
            ? 'text-[#E97E4F] hover:text-[#D96E42]'
            : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
        }`}
      >
        {isFullAccess(value) ? (
          <FullAccessPermissionIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
        ) : null}
        <span>{current.label}</span>
      </button>

      {open && !disabled && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            className={`popover-surface absolute left-0 z-20 flex min-w-[176px] flex-col p-1 ${
              menuSide === 'bottom' ? 'top-full mt-2' : 'bottom-full mb-2'
            }`}
          >
            {QODER_PERMISSION_MODES.map((mode) => (
              <QoderPermissionModeOption
                key={mode}
                mode={mode}
                current={value}
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

const MODE_META: Record<
  QoderPermissionMode,
  {
    label: string;
  }
> = {
  default: {
    label: 'Default',
  },
  plan: {
    label: 'Plan',
  },
  auto: {
    label: 'Auto',
  },
  acceptEdits: {
    label: 'Accept Edits',
  },
  dontAsk: {
    label: "Don't Ask",
  },
  yolo: {
    label: 'YOLO',
  },
  bypassPermissions: {
    label: 'Full Access',
  },
};

function QoderPermissionModeOption({
  mode,
  current,
  onSelect,
}: {
  mode: QoderPermissionMode;
  current: QoderPermissionMode;
  onSelect: (mode: QoderPermissionMode) => void;
}) {
  const active = current === mode;
  const meta = MODE_META[mode];

  return (
    <button
      type="button"
      onClick={() => onSelect(mode)}
      className={`rounded-lg px-3 py-1.5 text-left text-[13px] transition-colors ${
        active
          ? 'bg-[var(--bg-tertiary)] font-semibold text-[var(--text-primary)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
      }`}
    >
      <span className="truncate">{meta.label}</span>
    </button>
  );
}

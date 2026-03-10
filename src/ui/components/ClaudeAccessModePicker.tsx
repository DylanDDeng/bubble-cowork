import type { ClaudeAccessMode } from '../types';

export function ClaudeAccessModePicker({
  value,
  onChange,
  disabled,
}: {
  value: ClaudeAccessMode;
  onChange: (mode: ClaudeAccessMode) => void;
  disabled?: boolean;
}) {
  return (
    <div className="inline-flex items-center gap-1 rounded-[14px] bg-[var(--bg-tertiary)] p-1">
      <AccessModeButton
        label="Default"
        value="default"
        current={value}
        onClick={() => onChange('default')}
        disabled={disabled}
      />
      <AccessModeButton
        label="Full Access"
        value="fullAccess"
        current={value}
        onClick={() => onChange('fullAccess')}
        disabled={disabled}
      />
    </div>
  );
}

function AccessModeButton({
  label,
  value,
  current,
  onClick,
  disabled,
}: {
  label: string;
  value: ClaudeAccessMode;
  current: ClaudeAccessMode;
  onClick: () => void;
  disabled?: boolean;
}) {
  const active = current === value;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-[10px] px-3 py-1.5 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        active
          ? 'bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-[0_1px_2px_rgba(15,23,42,0.08)]'
          : 'bg-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
      }`}
    >
      {label}
    </button>
  );
}

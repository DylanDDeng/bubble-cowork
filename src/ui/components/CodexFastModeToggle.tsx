export function CodexFastModeToggle({
  enabled,
  onToggle,
  disabled,
}: {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(!enabled)}
      disabled={disabled}
      className={`inline-flex items-center gap-1 rounded-md py-1 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        enabled
          ? 'text-[#b42318] hover:text-[#991b1b]'
          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
      }`}
      title="Use Codex fast mode"
      aria-pressed={enabled}
    >
      <span>Fast</span>
    </button>
  );
}

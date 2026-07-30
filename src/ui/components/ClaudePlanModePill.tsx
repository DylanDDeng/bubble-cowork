import { Lightbulb, X } from './icons';

export function ClaudePlanModePill({
  onExit,
  disabled,
}: {
  onExit: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onExit}
      disabled={disabled}
      title="Exit Plan mode"
      aria-label="Exit Plan mode"
      className="group/plan inline-flex h-7 items-center gap-1 rounded-full bg-transparent px-2.5 text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="relative inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <Lightbulb
          className="h-3.5 w-3.5 transition-opacity duration-150 group-hover/plan:opacity-0"
          aria-hidden="true"
        />
        <span className="absolute inset-0 inline-flex items-center justify-center rounded-full bg-[var(--text-muted)] text-[var(--bg-primary)] opacity-0 transition-opacity duration-150 group-hover/plan:opacity-100">
          <X className="h-2 w-2 stroke-[2.25]" aria-hidden="true" />
        </span>
      </span>
      <span>Plan</span>
    </button>
  );
}

import { Check, ListChecks } from 'lucide-react';

export function PlanModeMenuItem({
  active,
  onChange,
  providerLabel,
}: {
  active: boolean;
  onChange: (active: boolean) => void;
  providerLabel: 'Claude' | 'Codex';
}) {
  const description =
    providerLabel === 'Codex'
      ? 'Ask Codex to plan first, with read-only tools.'
      : 'Ask Claude to plan first before editing.';

  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={active}
      onClick={() => onChange(!active)}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
    >
      <ListChecks className="h-4 w-4 flex-shrink-0 text-[var(--text-secondary)]" />
      <span className="min-w-0 flex-1">
        <span className="block truncate">Plan mode</span>
        <span className="block truncate text-[11px] leading-4 text-[var(--text-muted)]">
          {description}
        </span>
      </span>
      <span
        className={`flex h-4 w-7 flex-shrink-0 items-center rounded-full p-0.5 transition-colors ${
          active ? 'bg-[var(--accent)]' : 'bg-[var(--bg-tertiary)]'
        }`}
        aria-hidden="true"
      >
        <span
          className={`flex h-3 w-3 items-center justify-center rounded-full bg-[var(--bg-primary)] transition-transform ${
            active ? 'translate-x-3' : 'translate-x-0'
          }`}
        >
          {active ? <Check className="h-2.5 w-2.5 text-[var(--accent)]" /> : null}
        </span>
      </span>
    </button>
  );
}

export function PlanModeBadge({
  onDisable,
  disabled,
}: {
  onDisable: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onDisable}
      disabled={disabled}
      title="Plan mode is on. Click to return to Execute."
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent-light)] hover:text-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50 sm:px-3"
    >
      <ListChecks className="h-3.5 w-3.5 flex-shrink-0" />
      <span className="hidden sm:inline">Plan</span>
    </button>
  );
}

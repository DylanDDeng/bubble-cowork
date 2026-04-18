export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-[var(--border)] pb-6 last:border-b-0 last:pb-0">
      <div className="mb-3">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]">
          {title}
        </h2>
        {description ? (
          <p className="mt-1 text-[13px] leading-5 text-[var(--text-muted)]">{description}</p>
        ) : null}
      </div>
      <div>{children}</div>
    </section>
  );
}

export function SettingsRow({
  label,
  description,
  children,
  align = 'center',
  variant = 'plain',
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
  align?: 'center' | 'start';
  variant?: 'plain' | 'card';
}) {
  const isCard = variant === 'card';
  return (
    <div
      className={
        isCard
          ? `grid grid-cols-[minmax(0,1fr)_auto] gap-4 px-4 py-3 ${
              align === 'start' ? 'items-start' : 'items-center'
            }`
          : `grid grid-cols-[minmax(0,1fr)_minmax(200px,280px)] gap-4 border-b border-[var(--border)] py-3.5 last:border-b-0 ${
              align === 'start' ? 'items-start' : 'items-center'
            }`
      }
    >
      <div className="min-w-0">
        <div className={isCard ? 'text-[13px] font-medium text-[var(--text-primary)]' : 'text-[14px] font-medium text-[var(--text-primary)]'}>
          {label}
        </div>
        {description ? (
          <div className={isCard ? 'mt-0.5 text-[12px] leading-5 text-[var(--text-muted)]' : 'mt-0.5 text-[13px] leading-5 text-[var(--text-muted)]'}>
            {description}
          </div>
        ) : null}
      </div>
      <div className={align === 'start' ? '' : 'flex items-center justify-end'}>{children}</div>
    </div>
  );
}

// Cursor-style grouped card: a small muted label sits above a rounded white
// card that contains setting rows separated by hairline dividers.
export function SettingsGroup({
  title,
  description,
  children,
}: {
  title?: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      {title || description ? (
        <div className="mb-2 px-1">
          {title ? (
            <h2 className="text-[12px] font-medium text-[var(--text-muted)]">{title}</h2>
          ) : null}
          {description ? (
            <p className="mt-1 text-[12px] leading-5 text-[var(--text-muted)]">{description}</p>
          ) : null}
        </div>
      ) : null}
      <div className="overflow-hidden rounded-[12px] border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <div className="divide-y divide-[var(--border)]">{children}</div>
      </div>
    </section>
  );
}

// Segmented control group — a rounded pill strip that holds one or more
// `SegmentedControlItem`s. Use for view switchers, range pickers, or read-only
// status strips that need to feel like a group.
export function SegmentedControl({
  children,
  className = '',
  ariaLabel,
}: {
  children: React.ReactNode;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={`inline-flex items-center gap-0.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-0.5 ${className}`}
    >
      {children}
    </div>
  );
}

// A single pill inside `SegmentedControl`. Renders as a `<button>` when
// `onClick` is provided, otherwise as an inert `<div>` for read-only chips.
// `active` lifts the pill onto a raised white surface.
export function SegmentedControlItem({
  children,
  active = false,
  onClick,
  disabled,
  ariaLabel,
  className = '',
}: {
  children: React.ReactNode;
  active?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  const base = `inline-flex h-7 items-center justify-center gap-1.5 rounded-[5px] px-2.5 text-[12px] font-medium transition-colors ${
    active
      ? 'bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-[0_1px_2px_rgba(15,23,42,0.06)]'
      : onClick
        ? 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
        : 'text-[var(--text-primary)]'
  } disabled:opacity-60 ${className}`;

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-pressed={active}
        className={base}
      >
        {children}
      </button>
    );
  }

  return (
    <div aria-label={ariaLabel} className={base}>
      {children}
    </div>
  );
}

// iOS-style pill toggle. Green when on, neutral when off.
export function SettingsToggle({
  checked,
  onChange,
  disabled,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[22px] w-[38px] flex-shrink-0 items-center rounded-full border border-transparent transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40 disabled:opacity-50 ${
        checked ? 'bg-[var(--success)]' : 'bg-[var(--border)]'
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-[18px] w-[18px] transform rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-[2px]'
        }`}
      />
    </button>
  );
}

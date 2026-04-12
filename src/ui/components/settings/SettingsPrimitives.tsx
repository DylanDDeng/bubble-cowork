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
}: {
  label: string;
  description: string;
  children: React.ReactNode;
  align?: 'center' | 'start';
}) {
  return (
    <div
      className={`grid grid-cols-[minmax(0,1fr)_minmax(200px,280px)] gap-4 border-b border-[var(--border)] py-3.5 last:border-b-0 ${
        align === 'start' ? 'items-start' : 'items-center'
      }`}
    >
      <div>
        <div className="text-[14px] font-medium text-[var(--text-primary)]">{label}</div>
        {description ? (
          <div className="mt-0.5 text-[13px] leading-5 text-[var(--text-muted)]">{description}</div>
        ) : null}
      </div>
      <div className={align === 'start' ? '' : 'flex justify-end'}>{children}</div>
    </div>
  );
}

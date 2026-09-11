import { useState } from 'react';
import { ChevronDown, Code2, FolderOpen } from '../icons';
import * as DropdownMenu from '../ui/dropdown-menu';

export interface ApplicationDestinationOption {
  value: string;
  label: string;
  iconDataUrl?: string;
}

function ApplicationIcon({ option }: { option: ApplicationDestinationOption }) {
  const [failedSource, setFailedSource] = useState<string>();
  if (option.iconDataUrl && failedSource !== option.iconDataUrl) {
    return <img src={option.iconDataUrl} alt="" className="h-4 w-4 shrink-0 object-contain" onError={() => setFailedSource(option.iconDataUrl)} />;
  }
  const Icon = ['system', 'finder'].includes(option.value) ? FolderOpen : Code2;
  return <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />;
}

export function ApplicationDestinationSelect({ label, value, options, disabled, onChange }: {
  label: string;
  value: string;
  options: ApplicationDestinationOption[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  // Also filter retained pre-update lists: React refresh preserves parent state.
  const applications = options.filter(option => !['auto', 'automatic', 'system'].includes(option.value));
  // Resolve older automatic preferences to the same application as the workspace launcher.
  const selected = applications.find(option => option.value === value)
    ?? applications.find(option => option.value !== 'finder')
    ?? applications[0];
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          data-preference-value={selected?.value ?? value}
          disabled={disabled || applications.length === 0}
          className="inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-[10px] border border-[var(--border)] bg-transparent px-3 text-[13px] leading-4 text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-secondary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50"
        >
          {selected && <ApplicationIcon option={selected} />}
          <span className="truncate">{selected?.label || (disabled ? 'Loading…' : 'Unavailable')}</span>
          <ChevronDown aria-hidden="true" className="h-3 w-3 shrink-0 text-[var(--text-muted)]" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={2}
          aria-label={label}
          data-application-destination-menu
          className="w-[220px] max-w-[calc(100vw-24px)] p-1"
          style={{ borderRadius: 16 }}
        >
          <div className="max-h-80 overflow-y-auto overscroll-contain" style={{ maxHeight: 'min(320px, calc(var(--available-height, 100vh) - 10px))' }}>
            {applications.map(option => (
              <DropdownMenu.Item
                key={option.value}
                data-preference-option={option.value}
                onSelect={() => onChange(option.value)}
                className="h-7 gap-1.5 rounded-lg px-2 py-0 text-[13px] leading-4 text-[var(--text-primary)] data-[highlighted]:bg-[var(--sidebar-item-hover)]"
              >
                <ApplicationIcon option={option} />
                <span className="min-w-0 truncate">{option.label}</span>
              </DropdownMenu.Item>
            ))}
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

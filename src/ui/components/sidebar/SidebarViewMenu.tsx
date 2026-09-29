import { useMemo } from 'react';
import { shortcutLabel } from '../../../shared/keyboard-shortcuts';
import { useAppPreferences } from '../../store/useAppPreferences';
import { useAppStore } from '../../store/useAppStore';
import { useSidebarViewStore } from '../../store/useSidebarViewStore';
import {
  isDefaultSidebarView,
  SIDEBAR_ACTIVITY_LABELS,
  SIDEBAR_GROUP_LABELS,
  SIDEBAR_SORT_LABELS,
  SIDEBAR_STATUS_LABELS,
  type SidebarViewOptions,
} from '../../utils/sidebar-view';
import { Check, ChevronRight, SlidersHorizontal } from '../icons';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

const rowClass = 'gap-2 px-2.5 py-1.5 text-[13px] text-[var(--text-primary)]';

function projectLabel(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path;
}

function OptionItem({ label, selected, onSelect }: { label: string; selected: boolean; onSelect: () => void }) {
  return (
    <DropdownMenuItem onSelect={onSelect} className={rowClass} aria-checked={selected} role="menuitemradio">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {selected ? <Check className="h-3.5 w-3.5 flex-shrink-0" /> : null}
    </DropdownMenuItem>
  );
}

function OptionSubmenu<K extends keyof SidebarViewOptions>({
  label,
  valueLabel,
  options,
  current,
  onChange,
  separateLast,
}: {
  label: string;
  valueLabel: string;
  options: { value: SidebarViewOptions[K]; label: string }[];
  current: SidebarViewOptions[K];
  onChange: (value: SidebarViewOptions[K]) => void;
  /** Sets the last option apart (e.g. "None", "All projects"). */
  separateLast?: boolean;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger openOnHover delay={80} closeDelay={160} className="gap-2 px-2.5">
        <span className="flex-1">{label}</span>
        <span className="max-w-[110px] truncate text-[12.5px] text-[var(--text-muted)]">{valueLabel}</span>
        <ChevronRight className="h-3.5 w-3.5 text-[var(--text-muted)]" />
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent side="right" align="start" sideOffset={6} className="max-h-[360px] w-[184px] overflow-y-auto">
        {options.map((option, index) => (
          <div key={String(option.value)}>
            {separateLast && index === options.length - 1 && index > 0 ? <DropdownMenuSeparator /> : null}
            <OptionItem
              label={option.label}
              selected={option.value === current}
              onSelect={() => onChange(option.value)}
            />
          </div>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function entries<T extends string>(labels: Record<T, string>): { value: T; label: string }[] {
  return (Object.keys(labels) as T[]).map((value) => ({ value, label: labels[value] }));
}

/**
 * Sidebar view options: which sessions to show and how to group them. Group
 * by State is the triage view (what needs you, what runs, what to review).
 */
export function SidebarViewMenu({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  const view = useSidebarViewStore();
  const sessions = useAppStore((state) => state.sessions);
  const shortcuts = useAppPreferences((state) => state.keyboardShortcuts);
  const changed = !isDefaultSidebarView(view);

  const projects = useMemo(() => {
    const latest = new Map<string, number>();
    for (const session of Object.values(sessions)) {
      if (session.hiddenFromThreads || session.scope === 'dm') continue;
      const path = (session.projectCwd || session.cwd)?.trim();
      if (!path) continue;
      latest.set(path, Math.max(latest.get(path) ?? 0, session.updatedAt));
    }
    return Array.from(latest.entries())
      .sort((left, right) => right[1] - left[1])
      .map(([path]) => path);
  }, [sessions]);

  const projectOptions: { value: string | null; label: string }[] = [
    { value: null, label: 'All projects' },
    ...projects.map((path) => ({ value: path, label: projectLabel(path) })),
  ];
  if (view.project && !projects.includes(view.project)) {
    projectOptions.push({ value: view.project, label: projectLabel(view.project) });
  }
  const stateShortcut = shortcutLabel('activity', shortcuts);

  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className={`no-drag inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-[background-color,color,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] active:scale-95 data-[popup-open]:bg-[var(--sidebar-item-active)] ${
              changed
                ? 'bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_20%,transparent)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] data-[popup-open]:text-[var(--text-primary)]'
            }`}
            aria-label={changed ? 'View options (customized)' : 'View options'}
            title={stateShortcut ? `View options · ${stateShortcut} toggles Group by State` : 'View options'}
          />
        }
      >
        <SlidersHorizontal className="h-4 w-4" strokeWidth={1.4} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="w-[236px]">
        <OptionSubmenu<'status'>
          label="Status"
          valueLabel={SIDEBAR_STATUS_LABELS[view.status]}
          options={entries(SIDEBAR_STATUS_LABELS)}
          current={view.status}
          onChange={(value) => view.setOption('status', value)}
        />
        <OptionSubmenu<'project'>
          label="Project"
          valueLabel={view.project ? projectLabel(view.project) : 'All'}
          options={projectOptions}
          current={view.project}
          onChange={(value) => view.setOption('project', value)}
        />
        <OptionSubmenu<'activity'>
          label="Last activity"
          valueLabel={SIDEBAR_ACTIVITY_LABELS[view.activity]}
          options={entries(SIDEBAR_ACTIVITY_LABELS)}
          current={view.activity}
          onChange={(value) => view.setOption('activity', value)}
        />
        <DropdownMenuSeparator />
        <OptionSubmenu<'groupBy'>
          label="Group by"
          valueLabel={SIDEBAR_GROUP_LABELS[view.groupBy]}
          options={entries(SIDEBAR_GROUP_LABELS)}
          current={view.groupBy}
          onChange={(value) => view.setOption('groupBy', value)}
          separateLast
        />
        <OptionSubmenu<'sortBy'>
          label="Sort by"
          valueLabel={SIDEBAR_SORT_LABELS[view.sortBy]}
          options={entries(SIDEBAR_SORT_LABELS)}
          current={view.sortBy}
          onChange={(value) => view.setOption('sortBy', value)}
        />
        <DropdownMenuSeparator />
        <DropdownMenuItem
          closeOnClick={false}
          onSelect={() => view.setOption('showPullRequests', !view.showPullRequests)}
          className={rowClass}
          role="menuitemcheckbox"
          aria-checked={view.showPullRequests}
        >
          <span className="flex-1">Show PR status</span>
          {view.showPullRequests ? <Check className="h-3.5 w-3.5" /> : null}
        </DropdownMenuItem>
        {changed ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={view.reset} className={`${rowClass} text-[var(--text-secondary)]`}>
              Reset to default
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

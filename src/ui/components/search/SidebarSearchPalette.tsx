import { useEffect, useMemo, useState, type ComponentType } from 'react';
import {
  Bookmark,
  Boxes,
  FolderOpen,
  KanbanSquare,
  Search,
  Settings,
  SquarePen,
  MessageSquare,
} from 'lucide-react';
import {
  CommandDialog,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '../ui/command';
import {
  hasSidebarSearchResults,
  matchSidebarSearchActions,
  matchSidebarSearchProjects,
  matchSidebarSearchThreads,
  type SidebarSearchAction,
  type SidebarSearchProject,
  type SidebarSearchThread,
} from './SidebarSearchPalette.logic';

type IconComponent = ComponentType<{ className?: string }>;

const ACTION_ICONS: Record<string, IconComponent> = {
  'new-thread': SquarePen,
  'open-project': FolderOpen,
  'switch-chat': MessageSquare,
  'switch-board': KanbanSquare,
  'switch-prompts': Bookmark,
  'switch-skills': Boxes,
  settings: Settings,
};

interface SidebarSearchPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: readonly SidebarSearchAction[];
  projects: readonly SidebarSearchProject[];
  threads: readonly SidebarSearchThread[];
  onRunAction: (actionId: string) => void;
  onOpenProject: (projectId: string) => void;
  onOpenThread: (threadId: string) => void;
}

function formatRelativeTime(timestamp: number | undefined): string {
  if (!timestamp) return '';
  const delta = Date.now() - timestamp;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < hour) return `${Math.max(1, Math.round(delta / minute))}m`;
  if (delta < day) return `${Math.max(1, Math.round(delta / hour))}h`;
  const days = Math.max(1, Math.round(delta / day));
  if (days <= 7) return `${days}d`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(timestamp);
}

function threadMatchLabel(input: {
  matchKind: 'message' | 'project' | 'title';
  messageMatchCount: number;
}): string | null {
  if (input.matchKind === 'message') {
    return input.messageMatchCount > 1 ? `${input.messageMatchCount} chat hits` : 'Chat match';
  }
  if (input.matchKind === 'project') {
    return 'Project match';
  }
  return null;
}

function tokenizeHighlightQuery(query: string): string[] {
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .filter((t, i, all) => all.indexOf(t) === i);
  return [...tokens].sort((l, r) => r.length - l.length);
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function HighlightedText({
  text,
  query,
  className,
}: {
  text: string;
  query: string;
  className?: string;
}) {
  const segments = useMemo(() => {
    const tokens = tokenizeHighlightQuery(query);
    if (tokens.length === 0) {
      return [{ text, highlighted: false }];
    }
    const pattern = new RegExp(`(${tokens.map(escapeRegExp).join('|')})`, 'gi');
    const parts = text.split(pattern).filter((p) => p.length > 0);
    return parts.map((part) => ({
      text: part,
      highlighted: tokens.some((t) => t === part.toLowerCase()),
    }));
  }, [query, text]);

  return (
    <span className={className}>
      {segments.map((segment, index) =>
        segment.highlighted ? (
          <mark
            key={`${segment.text}-${index}`}
            className="rounded-[3px] bg-amber-200/80 px-[1px] text-current dark:bg-amber-300/25"
          >
            {segment.text}
          </mark>
        ) : (
          <span key={`${segment.text}-${index}`}>{segment.text}</span>
        )
      )}
    </span>
  );
}

function PaletteIcon({ icon: Icon }: { icon: IconComponent }) {
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--text-muted)]">
      <Icon className="h-[15px] w-[15px]" />
    </span>
  );
}

export function SidebarSearchPalette(props: SidebarSearchPaletteProps) {
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!props.open) setQuery('');
  }, [props.open]);

  const matchedActions = useMemo(
    () => matchSidebarSearchActions(props.actions, query),
    [props.actions, query]
  );
  const matchedProjects = useMemo(
    () => matchSidebarSearchProjects(props.projects, query),
    [props.projects, query]
  );
  const matchedThreads = useMemo(
    () => matchSidebarSearchThreads(props.threads, query),
    [props.threads, query]
  );

  const showActions = matchedActions.length > 0;
  const showThreads = matchedThreads.length > 0;
  const showProjects = matchedProjects.length > 0;
  const hasResults = hasSidebarSearchResults({
    actions: matchedActions,
    projects: matchedProjects,
    threads: matchedThreads,
  });

  const handleRunAction = (actionId: string) => {
    props.onOpenChange(false);
    props.onRunAction(actionId);
  };

  const handleOpenThread = (threadId: string) => {
    props.onOpenChange(false);
    props.onOpenThread(threadId);
  };

  const handleOpenProject = (projectId: string) => {
    props.onOpenChange(false);
    props.onOpenProject(projectId);
  };

  return (
    <CommandDialog open={props.open} onOpenChange={props.onOpenChange} label="Search">
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Search threads, projects, and actions"
        startAddon={<Search className="h-4 w-4" />}
      />

      <CommandList>
        {!hasResults ? (
          <CommandEmpty>
            <div className="flex flex-col items-center justify-center gap-2 py-6 text-center">
              <Search className="h-4 w-4 opacity-60" />
              <span>No matches.</span>
            </div>
          </CommandEmpty>
        ) : null}

        {showActions ? (
          <CommandGroup heading="Suggested">
            {matchedActions.map((action) => {
              const Icon = ACTION_ICONS[action.id];
              return (
                <CommandItem
                  key={action.id}
                  value={`action:${action.id}`}
                  onSelect={() => handleRunAction(action.id)}
                >
                  {Icon ? <PaletteIcon icon={Icon} /> : null}
                  <span className="min-w-0 flex-1 truncate">{action.label}</span>
                  {action.shortcutLabel ? (
                    <CommandShortcut>{action.shortcutLabel}</CommandShortcut>
                  ) : null}
                </CommandItem>
              );
            })}
          </CommandGroup>
        ) : null}

        {showActions && (showThreads || showProjects) ? <CommandSeparator /> : null}

        {showThreads ? (
          <CommandGroup heading={query ? 'Threads' : 'Recent'}>
            {matchedThreads.map(({ id, matchKind, messageMatchCount, snippet, thread }) => {
              const label = threadMatchLabel({ matchKind, messageMatchCount });
              return (
                <CommandItem
                  key={id}
                  value={id}
                  onSelect={() => handleOpenThread(thread.id)}
                >
                  <PaletteIcon icon={MessageSquare} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-3">
                      <div className="min-w-0 flex-1 truncate text-[13px] text-[var(--text-primary)]">
                        <HighlightedText
                          text={thread.title || 'Untitled thread'}
                          query={query}
                        />
                      </div>
                      <span className="w-20 shrink-0 truncate text-right text-[11px] text-[var(--text-muted)]/80">
                        {thread.projectName}
                      </span>
                      <span className="w-10 shrink-0 text-right text-[11px] text-[var(--text-muted)]/80">
                        {formatRelativeTime(thread.updatedAt)}
                      </span>
                    </div>
                    {snippet ? (
                      <div className="mt-0.5 flex items-start gap-3">
                        <div className="min-w-0 flex-1 truncate text-[11px] leading-5 text-[var(--text-secondary)]/80">
                          <HighlightedText text={snippet} query={query} />
                        </div>
                        {label ? (
                          <span className="shrink-0 text-[11px] text-[var(--text-muted)]/70">
                            {label}
                          </span>
                        ) : null}
                      </div>
                    ) : label ? (
                      <div className="mt-0.5 text-[11px] text-[var(--text-muted)]/70">
                        {label}
                      </div>
                    ) : null}
                  </div>
                </CommandItem>
              );
            })}
          </CommandGroup>
        ) : null}

        {showThreads && showProjects ? <CommandSeparator /> : null}

        {showProjects ? (
          <CommandGroup heading="Projects">
            {matchedProjects.map(({ id, project }) => (
              <CommandItem
                key={id}
                value={id}
                onSelect={() => handleOpenProject(project.id)}
              >
                <PaletteIcon icon={FolderOpen} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] text-[var(--text-primary)]">
                    <HighlightedText text={project.name} query={query} />
                  </div>
                  <div className="truncate text-[11px] text-[var(--text-muted)]/80">
                    {project.cwd}
                  </div>
                </div>
                <span className="shrink-0 text-[11px] text-[var(--text-muted)]/70">
                  {project.sessionCount} {project.sessionCount === 1 ? 'thread' : 'threads'}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>

      <CommandFooter>
        <span>Jump to threads, projects, and sidebar actions.</span>
        <span>Enter to open</span>
      </CommandFooter>
    </CommandDialog>
  );
}

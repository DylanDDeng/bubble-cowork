import { Fragment, useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { Boxes, FolderOpen, MessageSquare, Search, Settings, SquarePen } from '../icons';
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
  formatAge,
  isEmptyResult,
  markQueryWords,
  searchPalette,
  threadHitLabel,
  type PaletteAction,
  type PaletteProject,
  type PaletteThread,
} from './palette-ranking';

type Icon = ComponentType<{ className?: string }>;

const ACTION_ICON: Partial<Record<string, Icon>> = {
  'new-thread': SquarePen,
  'open-project': FolderOpen,
  'switch-chat': MessageSquare,
  'switch-skills': Boxes,
  settings: Settings,
};

export interface SearchPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: readonly PaletteAction[];
  projects: readonly PaletteProject[];
  threads: readonly PaletteThread[];
  onPickAction: (actionId: string) => void;
  /** Receives the project's working directory. */
  onPickProject: (cwd: string) => void;
  onPickThread: (threadId: string) => void;
}

function Marked({ text, query }: { text: string; query: string }) {
  const spans = useMemo(() => markQueryWords(text, query), [text, query]);
  return (
    <>
      {spans.map((span, index) =>
        span.marked ? (
          <mark key={index} className="rounded-[3px] bg-amber-200/80 px-[1px] text-current dark:bg-amber-300/25">
            {span.text}
          </mark>
        ) : (
          <Fragment key={index}>{span.text}</Fragment>
        )
      )}
    </>
  );
}

function ResultRow(props: {
  value: string;
  icon?: Icon;
  onSelect: () => void;
  title: ReactNode;
  detail?: ReactNode;
  aside?: ReactNode;
}) {
  const Glyph = props.icon;
  return (
    <CommandItem value={props.value} onSelect={props.onSelect}>
      {Glyph ? (
        <span className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--text-muted)]">
          <Glyph className="h-[15px] w-[15px]" />
        </span>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="truncate text-[13px] text-[var(--text-primary)]">{props.title}</div>
        {props.detail ? <div className="mt-0.5 truncate text-[13px] text-[var(--text-muted)]/80">{props.detail}</div> : null}
      </div>
      {props.aside}
    </CommandItem>
  );
}

const asideText = 'shrink-0 text-right text-[13px] text-[var(--text-muted)]/75';

export function SearchPalette(props: SearchPaletteProps) {
  const { open, onOpenChange } = props;
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const results = useMemo(
    () => searchPalette({ actions: props.actions, projects: props.projects, threads: props.threads }, query),
    [props.actions, props.projects, props.threads, query]
  );

  // Close first: the callbacks move focus and switch views.
  const closeThen = (run: () => void) => () => {
    onOpenChange(false);
    run();
  };

  const sections: Array<{ key: string; heading: string; rows: ReactNode[] }> = [
    {
      key: 'actions',
      heading: 'Suggested',
      rows: results.actions.map((action) => (
        <ResultRow
          key={action.id}
          value={`action:${action.id}`}
          icon={ACTION_ICON[action.id]}
          onSelect={closeThen(() => props.onPickAction(action.id))}
          title={action.label}
          aside={action.shortcut ? <CommandShortcut>{action.shortcut}</CommandShortcut> : null}
        />
      )),
    },
    {
      key: 'threads',
      heading: query ? 'Threads' : 'Recent',
      rows: results.threads.map((hit) => {
        const label = threadHitLabel(hit);
        return (
          <ResultRow
            key={hit.thread.id}
            value={`thread:${hit.thread.id}`}
            icon={MessageSquare}
            onSelect={closeThen(() => props.onPickThread(hit.thread.id))}
            title={
              <span className="flex items-baseline gap-3">
                <span className="min-w-0 flex-1 truncate">
                  <Marked text={hit.thread.title || 'Untitled thread'} query={query} />
                </span>
                <span className={`w-20 truncate ${asideText}`}>{hit.thread.projectName}</span>
                <span className={`w-10 ${asideText}`}>{formatAge(hit.thread.updatedAt)}</span>
              </span>
            }
            detail={
              hit.excerpt || label ? (
                <span className="flex items-start gap-3">
                  {hit.excerpt ? (
                    <span className="min-w-0 flex-1 truncate leading-5 text-[var(--text-secondary)]/80">
                      <Marked text={hit.excerpt} query={query} />
                    </span>
                  ) : null}
                  {label ? <span className="shrink-0 text-[var(--text-muted)]/70">{label}</span> : null}
                </span>
              ) : null
            }
          />
        );
      }),
    },
    {
      key: 'projects',
      heading: 'Projects',
      rows: results.projects.map((project) => (
        <ResultRow
          key={project.id}
          value={`project:${project.id}`}
          icon={FolderOpen}
          onSelect={closeThen(() => props.onPickProject(project.id))}
          title={<Marked text={project.name} query={query} />}
          detail={project.cwd}
          aside={
            <span className={asideText}>
              {project.sessionCount} {project.sessionCount === 1 ? 'thread' : 'threads'}
            </span>
          }
        />
      )),
    },
  ].filter((section) => section.rows.length > 0);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} label="Search">
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Search threads, projects, and actions"
        startAddon={<Search className="h-4 w-4" />}
      />
      <CommandList>
        {isEmptyResult(results) ? (
          <CommandEmpty>
            <div className="flex flex-col items-center justify-center gap-2 py-6 text-center">
              <Search className="h-4 w-4 opacity-60" />
              <span>No matches.</span>
            </div>
          </CommandEmpty>
        ) : null}
        {sections.map((section, index) => (
          <Fragment key={section.key}>
            {index > 0 ? <CommandSeparator /> : null}
            <CommandGroup heading={section.heading}>{section.rows}</CommandGroup>
          </Fragment>
        ))}
      </CommandList>
      <CommandFooter>
        <span>Sessions, projects and app commands</span>
        <span>↵ to open · esc to close</span>
      </CommandFooter>
    </CommandDialog>
  );
}

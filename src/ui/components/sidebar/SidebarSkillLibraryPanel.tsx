import { useEffect, useMemo, useState } from 'react';
import {
  Boxes,
  ExternalLink,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { sendEvent } from '../../hooks/useIPC';
import { useAppStore } from '../../store/useAppStore';
import type { ClaudeSkillSummary } from '../../types';

const MIN_REFRESH_SPINNER_MS = 500;

export function SidebarSkillLibraryPanel({ onShowProjects }: { onShowProjects?: () => void }) {
  const {
    activeSessionId,
    sessions,
    claudeUserSkills,
    claudeProjectSkills,
    setActiveWorkspace,
  } = useAppStore();
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshStartedAt, setRefreshStartedAt] = useState<number | null>(null);
  const [revealingPath, setRevealingPath] = useState<string | null>(null);
  const currentProjectPath = activeSessionId ? sessions[activeSessionId]?.cwd : undefined;

  useEffect(() => {
    sendEvent({
      type: 'skills.list',
      payload: { projectPath: currentProjectPath },
    });
  }, [currentProjectPath]);

  useEffect(() => {
    if (!refreshing) return;

    const elapsed = refreshStartedAt ? Date.now() - refreshStartedAt : MIN_REFRESH_SPINNER_MS;
    const remaining = Math.max(MIN_REFRESH_SPINNER_MS - elapsed, 0);
    const timer = window.setTimeout(() => {
      setRefreshing(false);
      setRefreshStartedAt(null);
    }, remaining);

    return () => window.clearTimeout(timer);
  }, [claudeProjectSkills, claudeUserSkills, refreshStartedAt, refreshing]);

  const filteredUserSkills = useMemo(
    () => filterSkills(claudeUserSkills, query),
    [claudeUserSkills, query]
  );
  const filteredProjectSkills = useMemo(
    () => filterSkills(claudeProjectSkills, query),
    [claudeProjectSkills, query]
  );

  const refreshSkills = () => {
    setRefreshing(true);
    setRefreshStartedAt(Date.now());
    sendEvent({
      type: 'skills.list',
      payload: { projectPath: currentProjectPath },
    });
  };

  const handleReveal = async (filePath: string) => {
    setRevealingPath(filePath);
    try {
      await window.electron.revealPath(filePath);
    } finally {
      setRevealingPath((current) => (current === filePath ? null : current));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col px-3 pb-3">
      {onShowProjects ? (
        <div className="px-1 pt-3">
          <button
            type="button"
            onClick={onShowProjects}
            className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
          >
            <FolderOpen className="h-3.5 w-3.5 text-[var(--text-muted)]" />
            <span className="text-[13px] font-normal">Projects</span>
          </button>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2 px-1 pb-3 pt-4">
        <div className="text-base font-medium text-[var(--text-primary)]">Skill Library</div>
        <div className="flex items-center gap-1">
          <IconButton title="Refresh skills" onClick={refreshSkills} disabled={refreshing}>
            {refreshing ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </IconButton>
          <IconButton title="Open full Skills" onClick={() => setActiveWorkspace('skills')}>
            <ExternalLink className="h-4 w-4" />
          </IconButton>
        </div>
      </div>

      <div className="relative px-1 pb-3">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search skills..."
          className="w-full rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] py-2 pl-9 pr-9 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]"
        />
        {query.trim() ? (
          <button
            type="button"
            onClick={() => setQuery('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
            aria-label="Clear skill search"
            title="Clear"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1 pb-1">
        <SkillSection
          title="User"
          skills={filteredUserSkills}
          emptyMessage={query.trim() ? 'No user skills match.' : 'No user skills found.'}
          revealingPath={revealingPath}
          onReveal={handleReveal}
        />
        <SkillSection
          title="Project"
          skills={filteredProjectSkills}
          emptyMessage={
            currentProjectPath
              ? query.trim()
                ? 'No project skills match.'
                : 'No project skills found.'
              : 'Open a project-backed thread first.'
          }
          revealingPath={revealingPath}
          onReveal={handleReveal}
        />
      </div>
    </div>
  );
}

function filterSkills(skills: ClaudeSkillSummary[], query: string): ClaudeSkillSummary[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return skills;

  return skills.filter((skill) =>
    [skill.title, skill.name, skill.description || ''].some((value) =>
      value.toLowerCase().includes(normalizedQuery)
    )
  );
}

function SkillSection({
  title,
  skills,
  emptyMessage,
  revealingPath,
  onReveal,
}: {
  title: string;
  skills: ClaudeSkillSummary[];
  emptyMessage: string;
  revealingPath: string | null;
  onReveal: (filePath: string) => Promise<void>;
}) {
  return (
    <section className="mb-5">
      <div className="mb-2 flex items-center justify-between gap-3 px-1">
        <div className="text-[12px] font-normal text-[var(--text-secondary)]">{title}</div>
        <div className="text-[11px] text-[var(--text-muted)]">{skills.length}</div>
      </div>

      {skills.length === 0 ? (
        <div className="rounded-[var(--radius-xl)] border border-dashed border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-3 text-[12px] leading-5 text-[var(--text-muted)]">
          {emptyMessage}
        </div>
      ) : (
        <div className="space-y-2">
          {skills.map((skill) => (
            <SkillListItem
              key={skill.path}
              skill={skill}
              revealing={revealingPath === skill.path}
              onReveal={onReveal}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SkillListItem({
  skill,
  revealing,
  onReveal,
}: {
  skill: ClaudeSkillSummary;
  revealing: boolean;
  onReveal: (filePath: string) => Promise<void>;
}) {
  return (
    <article className="group rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-3">
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[var(--radius-lg)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
          <Boxes className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-normal text-[var(--text-primary)]">
            {skill.title || skill.name}
          </div>
          <div className="truncate text-[11px] text-[var(--text-muted)]">{skill.name}</div>
          {skill.description ? (
            <div className="mt-1 line-clamp-2 text-[12px] leading-5 text-[var(--text-secondary)]">
              {skill.description}
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-2 flex justify-end opacity-0 transition-opacity duration-150 group-hover:opacity-100">
        <button
          type="button"
          onClick={() => void onReveal(skill.path)}
          disabled={revealing}
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {revealing ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <ExternalLink className="h-3 w-3" />}
          <span>{revealing ? 'Opening' : 'Reveal'}</span>
        </button>
      </div>
    </article>
  );
}

function IconButton({
  children,
  disabled,
  onClick,
  title,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

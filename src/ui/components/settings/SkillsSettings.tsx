import { useEffect, useMemo, useState } from 'react';
import { Boxes, LoaderCircle, Search, X } from 'lucide-react';
import { sendEvent } from '../../hooks/useIPC';
import { useAppStore } from '../../store/useAppStore';
import type { ClaudeSkillSummary } from '../../types';

const MIN_REFRESH_SPINNER_MS = 600;

export function SkillsSettingsContent() {
  return <SkillsSettingsContentInner />;
}

export function SkillsSettingsContentInner({ embedded = false }: { embedded?: boolean }) {
  const {
    activeSessionId,
    sessions,
    claudeUserSkills,
    claudeProjectSkills,
    claudeSkillsUserRoot,
    claudeSkillsProjectRoot,
  } = useAppStore();

  const [revealingPath, setRevealingPath] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshStartedAt, setRefreshStartedAt] = useState<number | null>(null);
  const [query, setQuery] = useState('');

  const currentProjectPath = activeSessionId ? sessions[activeSessionId]?.cwd : undefined;
  const currentProjectName = currentProjectPath?.split('/').filter(Boolean).pop();

  useEffect(() => {
    sendEvent({
      type: 'skills.list',
      payload: { projectPath: currentProjectPath },
    });
  }, [currentProjectPath]);

  useEffect(() => {
    if (!refreshing) {
      return;
    }

    const elapsed = refreshStartedAt ? Date.now() - refreshStartedAt : MIN_REFRESH_SPINNER_MS;
    const remaining = Math.max(MIN_REFRESH_SPINNER_MS - elapsed, 0);
    const timer = window.setTimeout(() => {
      setRefreshing(false);
      setRefreshStartedAt(null);
    }, remaining);

    return () => {
      window.clearTimeout(timer);
    };
  }, [
    claudeProjectSkills,
    claudeSkillsProjectRoot,
    claudeSkillsUserRoot,
    claudeUserSkills,
    refreshStartedAt,
    refreshing,
  ]);

  const filteredUserSkills = useMemo(
    () => filterSkills(claudeUserSkills, query),
    [claudeUserSkills, query]
  );
  const filteredProjectSkills = useMemo(
    () => filterSkills(claudeProjectSkills, query),
    [claudeProjectSkills, query]
  );
  const hasSearchQuery = query.trim().length > 0;

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
    <div className={embedded ? 'space-y-6 pb-2' : 'space-y-8 pb-16'}>
      <div className={`flex items-start justify-between gap-4 ${embedded ? '' : ''}`}>
        {!embedded && (
          <div className="space-y-1">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
              Installed
            </div>
            <h3 className="text-lg font-semibold text-[var(--text-primary)]">Claude Code Skills</h3>
            <p className="text-sm text-[var(--text-secondary)] max-w-2xl">
              A cleaner overview of the user and workspace skills the Claude runner can discover.
            </p>
          </div>
        )}

        <div className={`flex w-full items-center gap-2 ${embedded ? 'max-w-[520px]' : 'max-w-[460px]'}`}>
          <div className="relative flex-1">
            <div className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]">
              <Search className="h-3.5 w-3.5" />
            </div>
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search skills..."
              className="h-10 w-full rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] pl-9 pr-9 text-sm text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--border)]"
            />
            {hasSearchQuery && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                aria-label="Clear skill search"
                title="Clear"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          <button
            onClick={refreshSkills}
            disabled={refreshing}
            className="inline-flex items-center gap-2 rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {refreshing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
            <span>{refreshing ? 'Refreshing...' : 'Refresh'}</span>
          </button>
        </div>
      </div>

      <SkillsSection
        title="User Skills"
        description="Available to every Claude session on this machine."
        rootPath={claudeSkillsUserRoot}
        skills={filteredUserSkills}
        emptyMessage={hasSearchQuery ? 'No user-level skills match this search.' : 'No user-level skills found.'}
        revealingPath={revealingPath}
        onReveal={handleReveal}
      />

      <SkillsSection
        title="Project Skills"
        description={
          currentProjectPath
            ? `Available when the active session uses ${currentProjectName || 'this workspace'} as its working directory.`
            : 'Open a session with a working directory to inspect workspace-specific skills.'
        }
        rootPath={claudeSkillsProjectRoot}
        skills={filteredProjectSkills}
        emptyMessage={
          currentProjectPath
            ? hasSearchQuery
              ? 'No workspace-level skills match this search.'
              : 'No workspace-level skills found for this project.'
            : 'No active workspace selected.'
        }
        unavailable={!currentProjectPath}
        revealingPath={revealingPath}
        onReveal={handleReveal}
      />
    </div>
  );
}

function filterSkills(skills: ClaudeSkillSummary[], query: string): ClaudeSkillSummary[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return skills;
  }

  return skills.filter((skill) => {
    const haystacks = [skill.title, skill.name, skill.description || ''];
    return haystacks.some((value) => value.toLowerCase().includes(normalizedQuery));
  });
}

function SkillsSection({
  title,
  description,
  rootPath,
  skills,
  emptyMessage,
  unavailable = false,
  revealingPath,
  onReveal,
}: {
  title: string;
  description: string;
  rootPath?: string;
  skills: ClaudeSkillSummary[];
  emptyMessage: string;
  unavailable?: boolean;
  revealingPath: string | null;
  onReveal: (filePath: string) => Promise<void>;
}) {
  return (
    <section className="space-y-3">
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-4">
          <h4 className="text-lg font-semibold text-[var(--text-primary)]">{title}</h4>
          <span className="text-xs text-[var(--text-muted)]">
            {skills.length} {skills.length === 1 ? 'skill' : 'skills'}
          </span>
        </div>
        <p className="text-sm text-[var(--text-secondary)]">{description}</p>
      </div>

      <div className="h-px bg-[var(--border)]" />

      {skills.length === 0 ? (
        <div className="rounded-[var(--radius-2xl)] border border-dashed border-[var(--border)] bg-[var(--bg-secondary)] p-4 text-sm text-[var(--text-muted)]">
          {emptyMessage}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {skills.map((skill) => (
            <SkillCard
              key={skill.path}
              skill={skill}
              revealing={revealingPath === skill.path}
              onReveal={onReveal}
            />
          ))}
        </div>
      )}

      {unavailable && (
        <div className="text-xs text-[var(--text-muted)]">
          Project skills are only resolved when Claude receives a concrete session CWD.
        </div>
      )}
    </section>
  );
}

function SkillCard({
  skill,
  revealing,
  onReveal,
}: {
  skill: ClaudeSkillSummary;
  revealing: boolean;
  onReveal: (filePath: string) => Promise<void>;
}) {
  return (
    <article className="rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-4 shadow-[0_6px_18px_rgba(0,0,0,0.03)]">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[var(--radius-2xl)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
          <Boxes className="w-4.5 h-4.5" />
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2 min-w-0">
            <h5 className="truncate text-[15px] font-medium tracking-[-0.01em] text-[var(--text-primary)]">
              {skill.title.toUpperCase()}
            </h5>
          </div>

          <p className="line-clamp-2 text-sm leading-6 text-[var(--text-secondary)]" title={skill.description}>
            {skill.description || `/${skill.name}`}
          </p>

          <div className="flex items-center gap-2">
            <span
              className="inline-flex min-w-[96px] max-w-[180px] items-center justify-center rounded-full bg-[var(--bg-tertiary)] px-3 py-1 text-[10px] leading-4 text-[var(--text-muted)]"
              title={skill.name}
            >
              {skill.name}
            </span>
          </div>
        </div>

        <button
          onClick={() => void onReveal(skill.path)}
          disabled={revealing}
          className="flex-shrink-0 rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {revealing ? 'Revealing...' : 'Reveal'}
        </button>
      </div>
    </article>
  );
}

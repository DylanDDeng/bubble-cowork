import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Boxes, ExternalLink, FileText, LoaderCircle, Search, X } from 'lucide-react';
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
  const [selectedSkillPath, setSelectedSkillPath] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailBody, setDetailBody] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

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
  const visibleSkills = useMemo(
    () => [...filteredUserSkills, ...filteredProjectSkills],
    [filteredProjectSkills, filteredUserSkills]
  );
  const selectedSkill = useMemo(
    () => visibleSkills.find((skill) => skill.path === selectedSkillPath) || null,
    [selectedSkillPath, visibleSkills]
  );

  useEffect(() => {
    if (!detailOpen || !selectedSkill) {
      setDetailBody('');
      setDetailError(null);
      setDetailLoading(false);
      return;
    }

    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    setDetailBody('');

    void window.electron
      .expandClaudeSkillPrompt(selectedSkill.path, selectedSkill.name, '')
      .then((result) => {
        if (cancelled) {
          return;
        }

        if (result.ok && result.prompt) {
          setDetailBody(extractSkillInstructions(result.prompt));
        } else {
          setDetailError(result.message || 'Failed to load skill detail.');
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setDetailError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDetailLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [detailOpen, selectedSkill]);

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

  const openSkillDetail = (filePath: string) => {
    setSelectedSkillPath(filePath);
    setDetailOpen(true);
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

      <div className="min-h-[calc(100vh-240px)] space-y-7">
        <SkillsSection
          title="User Skills"
          description="Available to every Claude session on this machine."
          rootPath={claudeSkillsUserRoot}
          skills={filteredUserSkills}
          emptyMessage={hasSearchQuery ? 'No user-level skills match this search.' : 'No user-level skills found.'}
          revealingPath={revealingPath}
          onSelect={openSkillDetail}
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
          onSelect={openSkillDetail}
          onReveal={handleReveal}
        />

        <SkillDetailDialog
          open={detailOpen}
          onOpenChange={setDetailOpen}
          skill={selectedSkill}
          body={detailBody}
          loading={detailLoading}
          error={detailError}
          revealing={selectedSkill ? revealingPath === selectedSkill.path : false}
          onReveal={handleReveal}
        />
      </div>
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

function extractSkillInstructions(prompt: string): string {
  const match = prompt.match(/<skill_instructions>\n?([\s\S]*?)\n?<\/skill_instructions>/);
  return (match?.[1] || prompt).trim();
}

function SkillsSection({
  title,
  description,
  rootPath,
  skills,
  emptyMessage,
  unavailable = false,
  revealingPath,
  onSelect,
  onReveal,
}: {
  title: string;
  description: string;
  rootPath?: string;
  skills: ClaudeSkillSummary[];
  emptyMessage: string;
  unavailable?: boolean;
  revealingPath: string | null;
  onSelect: (filePath: string) => void;
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
              onSelect={onSelect}
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
  onSelect,
  onReveal,
}: {
  skill: ClaudeSkillSummary;
  revealing: boolean;
  onSelect: (filePath: string) => void;
  onReveal: (filePath: string) => Promise<void>;
}) {
  return (
    <article
      role="button"
      tabIndex={0}
      onClick={() => onSelect(skill.path)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(skill.path);
        }
      }}
      className="cursor-pointer rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-4 shadow-[0_6px_18px_rgba(0,0,0,0.03)] transition-colors hover:bg-[var(--bg-tertiary)]"
      aria-label={`Open ${skill.title || skill.name} skill detail`}
    >
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[var(--radius-2xl)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
          <Boxes className="w-4.5 h-4.5" />
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2 min-w-0">
            <h5 className="truncate text-[15px] font-medium tracking-[-0.01em] text-[var(--text-primary)]">
              {skill.title || skill.name}
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
          onClick={(event) => {
            event.stopPropagation();
            void onReveal(skill.path);
          }}
          disabled={revealing}
          className="flex-shrink-0 rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {revealing ? 'Revealing...' : 'Reveal'}
        </button>
      </div>
    </article>
  );
}

function SkillDetailDialog({
  open,
  onOpenChange,
  skill,
  body,
  loading,
  error,
  revealing,
  onReveal,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  skill: ClaudeSkillSummary | null;
  body: string;
  loading: boolean;
  error: string | null;
  revealing: boolean;
  onReveal: (filePath: string) => Promise<void>;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[80] bg-black/35 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[81] flex max-h-[82vh] w-[min(920px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[var(--bg-secondary)] shadow-[0_24px_80px_rgba(0,0,0,0.22)]">
          {!skill ? (
            <div className="p-6 text-sm leading-6 text-[var(--text-muted)]">Select a skill card to inspect its instructions.</div>
          ) : (
            <>
          <div className="border-b border-[var(--border)] px-5 py-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-2">
                <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
                  <FileText className="h-3.5 w-3.5" />
                  <span>{skill.source} skill</span>
                </div>
                <h4 className="break-words text-[24px] font-semibold tracking-[-0.025em] text-[var(--text-primary)]">
                  {skill.title || skill.name}
                </h4>
                <p className="break-words text-sm leading-6 text-[var(--text-secondary)]">
                  {skill.description || `/${skill.name}`}
                </p>
              </div>

              <div className="flex flex-shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => void onReveal(skill.path)}
                  disabled={revealing}
                  className="inline-flex items-center gap-1.5 rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {revealing ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
                  <span>{revealing ? 'Opening' : 'Reveal'}</span>
                </button>
                <Dialog.Close asChild>
                  <button
                    type="button"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-xl)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                    aria-label="Close skill detail"
                    title="Close"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </Dialog.Close>
              </div>
            </div>

            <div className="mt-4 space-y-2 rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] p-3 text-[12px] leading-5 text-[var(--text-muted)]">
              <div className="break-all">
                <span className="text-[var(--text-secondary)]">Name:</span> {skill.name}
              </div>
              <div className="break-all">
                <span className="text-[var(--text-secondary)]">Path:</span> {skill.path}
              </div>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            <div className="mb-3 text-[12px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
              Instructions
            </div>
            {loading ? (
              <div className="flex min-h-[220px] items-center justify-center gap-2 rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] p-4 text-sm text-[var(--text-secondary)]">
                <LoaderCircle className="h-4 w-4 animate-spin" />
                <span>Loading skill detail...</span>
              </div>
            ) : error ? (
              <div className="rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] p-4 text-sm leading-6 text-[var(--error)]">
                {error}
              </div>
            ) : (
              <pre className="max-h-[46vh] whitespace-pre-wrap break-words overflow-auto rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] p-4 font-mono text-[12px] leading-6 text-[var(--text-primary)]">
                {body || 'No skill instructions found.'}
              </pre>
            )}
          </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

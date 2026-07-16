import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@/ui/components/ui/dialog';
import { Check, LoaderCircle, RefreshCw, Search, SkillStack, X } from '../icons';
import { sendEvent } from '../../hooks/useIPC';
import { MDContent } from '../../render/markdown';
import { useAppStore } from '../../store/useAppStore';
import type { ClaudeSkillSummary } from '../../types';
import { formatSeeMoreNames, inferSkillGlyph, SkillCubeMark } from './CodexPluginLibrary';

const COLLAPSED_SECTION_ROWS = 6;

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
  // Keyed by skill path so the dialog never paints a stale/empty body for a
  // frame while the load effect catches up (see CodexSkillDetailDialog).
  const [detail, setDetail] = useState<{
    path: string;
    body: string;
    error: string | null;
  } | null>(null);

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

  // Preload the instructions before opening: local expansion settles in a few
  // ms, so the dialog's first frame is already the full document — no
  // spinner-to-content swap, no dialog height jump. Slow loads (>300ms) open
  // with a spinner instead of blocking the click.
  const openSkillDetail = async (filePath: string) => {
    setSelectedSkillPath(filePath);
    const skill = visibleSkills.find((candidate) => candidate.path === filePath);
    if (skill) {
      const load = window.electron
        .expandClaudeSkillPrompt(filePath, skill.name, '')
        .then((result) => {
          if (result.ok && result.prompt) {
            setDetail({
              path: filePath,
              body: extractSkillInstructions(result.prompt),
              error: null,
            });
          } else {
            setDetail({
              path: filePath,
              body: '',
              error: result.message || 'Failed to load skill detail.',
            });
          }
        })
        .catch((error) => {
          setDetail({
            path: filePath,
            body: '',
            error: error instanceof Error ? error.message : String(error),
          });
        });
      await Promise.race([load, new Promise((resolve) => setTimeout(resolve, 300))]);
    }
    setDetailOpen(true);
  };

  return (
    <div className={embedded ? 'space-y-6 pb-2' : 'space-y-8 pb-16'}>
      <section className="mx-auto min-h-[calc(100vh-240px)] w-full max-w-[820px] space-y-6">
        <div className="space-y-1.5">
          <h2 className="text-[30px] font-semibold tracking-[-0.03em] text-[var(--text-primary)]">
            Skills
          </h2>
          <p className="text-sm text-[var(--text-secondary)]" title={claudeSkillsUserRoot}>
            Extend Claude with task-specific skills
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search skills"
              className="h-11 w-full rounded-full border border-[var(--border)] bg-[var(--bg-primary)] pl-11 pr-10 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--border-focus)]"
            />
            {hasSearchQuery && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                aria-label="Clear skill search"
                title="Clear"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <button
            onClick={refreshSkills}
            disabled={refreshing}
            className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-[var(--border)] px-3.5 text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {refreshing ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            <span>Refresh</span>
          </button>
        </div>

        <ClaudeSkillSection
          title="Personal"
          skills={filteredUserSkills}
          emptyMessage={hasSearchQuery ? 'No personal skills match this search.' : 'No personal skills found.'}
          onSelect={openSkillDetail}
        />

        <ClaudeSkillSection
          title={currentProjectName ? `Project · ${currentProjectName}` : 'Project'}
          skills={filteredProjectSkills}
          emptyMessage={
            currentProjectPath
              ? hasSearchQuery
                ? 'No project skills match this search.'
                : 'No project skills found for this workspace.'
              : 'Open a session with a working directory to inspect project skills.'
          }
          rootPath={claudeSkillsProjectRoot}
          onSelect={openSkillDetail}
        />
      </section>

      <SkillDetailDialog
        open={detailOpen}
        onOpenChange={setDetailOpen}
        skill={selectedSkill}
        detail={detail}
        revealing={selectedSkill ? revealingPath === selectedSkill.path : false}
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

function extractSkillInstructions(prompt: string): string {
  const match = prompt.match(/<skill_instructions>\n?([\s\S]*?)\n?<\/skill_instructions>/);
  return (match?.[1] || prompt).trim();
}

function ClaudeSkillSection({
  title,
  skills,
  emptyMessage,
  rootPath,
  onSelect,
}: {
  title: string;
  skills: ClaudeSkillSummary[];
  emptyMessage: string;
  rootPath?: string;
  onSelect: (filePath: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? skills : skills.slice(0, COLLAPSED_SECTION_ROWS);
  const hidden = skills.slice(visible.length);

  return (
    <div className="space-y-3">
      <div
        className="border-b border-[var(--border)] pb-2 text-[15px] font-medium text-[var(--text-primary)]"
        title={rootPath}
      >
        {title}
      </div>

      {skills.length === 0 ? (
        <p className="py-1 text-sm text-[var(--text-muted)]">{emptyMessage}</p>
      ) : (
        <div className="grid grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2">
          {visible.map((skill) => (
            <ClaudeSkillRow key={skill.path} skill={skill} onSelect={() => onSelect(skill.path)} />
          ))}
        </div>
      )}

      {hidden.length > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="rounded-full py-1 text-[13px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
        >
          {formatSeeMoreNames(hidden.map((skill) => skill.title || skill.name))}
        </button>
      )}
      {expanded && skills.length > COLLAPSED_SECTION_ROWS && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="rounded-full py-1 text-[13px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
        >
          Show less
        </button>
      )}
    </div>
  );
}

function ClaudeSkillRow({
  skill,
  onSelect,
}: {
  skill: ClaudeSkillSummary;
  onSelect: () => void;
}) {
  const title = skill.title || skill.name;
  const description = skill.description || `/${skill.name}`;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
      className="group flex cursor-pointer items-center gap-3 rounded-[14px] px-2 py-2 transition-colors hover:bg-[var(--bg-secondary)]"
      aria-label={`Open ${title} skill detail`}
    >
      <ClaudeSkillTile name={skill.name} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-medium text-[var(--text-primary)]">{title}</div>
        <div className="truncate text-[13px] text-[var(--text-muted)]" title={skill.description}>
          {description}
        </div>
      </div>
      <Check className="h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-label="Available" />
    </div>
  );
}

function ClaudeSkillTile({ name }: { name: string }) {
  const Glyph = inferSkillGlyph(name);
  return (
    <span
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-[color-mix(in_srgb,var(--border)_55%,transparent)] bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
      aria-hidden="true"
    >
      {Glyph === SkillStack ? (
        <SkillCubeMark className="h-[22px] w-[22px]" />
      ) : (
        <Glyph className="h-[18px] w-[18px]" />
      )}
    </span>
  );
}

function SkillDetailDialog({
  open,
  onOpenChange,
  skill,
  detail,
  revealing,
  onReveal,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  skill: ClaudeSkillSummary | null;
  detail: { path: string; body: string; error: string | null } | null;
  revealing: boolean;
  onReveal: (filePath: string) => Promise<void>;
}) {
  const { activeSessionId, setShowSettings } = useAppStore();
  const ready = Boolean(skill && detail?.path === skill.path);

  const tryNow = () => {
    if (!skill || !activeSessionId) return;
    onOpenChange(false);
    setShowSettings(false);
    window.requestAnimationFrame(() => {
      window.dispatchEvent(
        new CustomEvent('aegis-composer-set-prompt', {
          detail: { sessionId: activeSessionId, text: `/${skill.name} ` },
        })
      );
    });
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[80] bg-black/35 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[81] flex max-h-[86vh] w-[min(860px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[22px] border border-[var(--border)] bg-[var(--bg-secondary)] shadow-[0_24px_80px_rgba(0,0,0,0.22)]">
          {!skill ? (
            <div className="p-6 text-sm leading-6 text-[var(--text-muted)]">Select a skill card to inspect its instructions.</div>
          ) : (
            <>
              <div className="flex items-start justify-between gap-3 px-7 pt-6">
                <ClaudeSkillTile name={skill.name} />
                <Dialog.Close asChild>
                  <button
                    type="button"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                    aria-label="Close skill detail"
                    title="Close"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </Dialog.Close>
              </div>

              <div className="space-y-1 px-7 pb-5 pt-4">
                <h4 className="break-words text-[22px] font-semibold tracking-[-0.02em] text-[var(--text-primary)]">
                  {skill.title || skill.name}{' '}
                  <span className="font-normal text-[var(--text-muted)]">Skill</span>
                </h4>
                {skill.description && (
                  <p className="break-words text-sm leading-6 text-[var(--text-secondary)]">
                    {skill.description}
                  </p>
                )}
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-7">
                <div className="rounded-[16px] border border-[color-mix(in_srgb,var(--border)_75%,transparent)] bg-[var(--bg-primary)] px-6 py-5">
                  {!ready ? (
                    <div className="flex min-h-32 items-center justify-center">
                      <LoaderCircle className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
                    </div>
                  ) : detail?.error ? (
                    <p className="text-sm text-[var(--text-muted)]">{detail.error}</p>
                  ) : detail?.body ? (
                    <MDContent
                      content={detail.body}
                      allowHtml={false}
                      className="project-markdown-preview"
                    />
                  ) : (
                    <p className="text-sm text-[var(--text-muted)]">No skill instructions found.</p>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between gap-3 px-7 py-5">
                <button
                  type="button"
                  onClick={() => void onReveal(skill.path)}
                  disabled={revealing}
                  className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[var(--border)] px-3.5 text-[13px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {revealing ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}
                  Reveal in Finder
                </button>
                {activeSessionId ? (
                  <button
                    type="button"
                    onClick={tryNow}
                    className="inline-flex h-8 items-center gap-1.5 rounded-full bg-[var(--text-primary)] px-4 text-[13px] font-medium text-[var(--bg-primary)] transition-opacity hover:opacity-90"
                  >
                    Try now
                  </button>
                ) : null}
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

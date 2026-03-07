import { useEffect, useState } from 'react';
import { Boxes } from 'lucide-react';
import { sendEvent } from '../../hooks/useIPC';
import { useAppStore } from '../../store/useAppStore';
import type { ClaudeSkillSummary } from '../../types';

export function SkillsSettingsContent() {
  const {
    showSettings,
    activeSessionId,
    sessions,
    claudeUserSkills,
    claudeProjectSkills,
    claudeSkillsUserRoot,
    claudeSkillsProjectRoot,
  } = useAppStore();

  const [revealingPath, setRevealingPath] = useState<string | null>(null);

  const currentProjectPath = activeSessionId ? sessions[activeSessionId]?.cwd : undefined;
  const currentProjectName = currentProjectPath?.split('/').filter(Boolean).pop();

  useEffect(() => {
    if (!showSettings) {
      return;
    }

    sendEvent({
      type: 'skills.list',
      payload: { projectPath: currentProjectPath },
    });
  }, [showSettings, currentProjectPath]);

  const refreshSkills = () => {
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
    <div className="space-y-8 pb-16">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
            Installed
          </div>
          <h3 className="text-lg font-semibold text-[var(--text-primary)]">Claude Code Skills</h3>
          <p className="text-sm text-[var(--text-secondary)] max-w-2xl">
            A cleaner overview of the user and workspace skills the Claude runner can discover.
          </p>
        </div>

        <button
          onClick={refreshSkills}
          className="px-3 py-2 text-sm rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors"
        >
          Refresh
        </button>
      </div>

      <SkillsSection
        title="User Skills"
        description="Available to every Claude session on this machine."
        rootPath={claudeSkillsUserRoot}
        skills={claudeUserSkills}
        emptyMessage="No user-level skills found."
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
        skills={claudeProjectSkills}
        emptyMessage={
          currentProjectPath
            ? 'No workspace-level skills found for this project.'
            : 'No active workspace selected.'
        }
        unavailable={!currentProjectPath}
        revealingPath={revealingPath}
        onReveal={handleReveal}
      />
    </div>
  );
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
        <div className="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--bg-secondary)] p-4 text-sm text-[var(--text-muted)]">
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
    <article className="rounded-[22px] border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-4 shadow-[0_6px_18px_rgba(0,0,0,0.03)]">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-2xl bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
          <Boxes className="w-4.5 h-4.5" />
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2 min-w-0">
            <h5 className="truncate text-[17px] font-medium tracking-[-0.01em] text-[var(--text-primary)]">
              {skill.title}
            </h5>
          </div>

          <p className="line-clamp-2 text-sm leading-6 text-[var(--text-secondary)]" title={skill.description}>
            {skill.description || `/${skill.name}`}
          </p>

          <div className="flex items-center gap-2">
            <span
              className="inline-flex min-w-[96px] max-w-[180px] items-center justify-center rounded-full bg-[var(--bg-tertiary)] px-3 py-1 text-[11px] leading-4 text-[var(--text-muted)]"
              title={skill.name}
            >
              {skill.name}
            </span>
          </div>
        </div>

        <button
          onClick={() => void onReveal(skill.path)}
          disabled={revealing}
          className="flex-shrink-0 rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {revealing ? 'Revealing...' : 'Reveal'}
        </button>
      </div>
    </article>
  );
}

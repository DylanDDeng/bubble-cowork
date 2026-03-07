import { useEffect, useState } from 'react';
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
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-[var(--text-primary)]">Claude Code Skills</h3>
          <p className="text-sm text-[var(--text-secondary)] max-w-2xl">
            This list comes from the same user and project paths the Claude runner loads through
            <span className="font-mono"> settingSources: [user, project]</span>.
          </p>
        </div>

        <button
          onClick={refreshSkills}
          className="px-3 py-2 text-sm rounded-lg border border-[var(--border-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
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
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-4">
          <h4 className="text-sm font-medium text-[var(--text-primary)]">{title}</h4>
          <span className="text-xs text-[var(--text-muted)]">
            {skills.length} {skills.length === 1 ? 'skill' : 'skills'}
          </span>
        </div>
        <p className="text-sm text-[var(--text-secondary)]">{description}</p>
        <div className="text-xs font-mono text-[var(--text-muted)] break-all">
          {rootPath || 'Path unavailable until a workspace is selected.'}
        </div>
      </div>

      {skills.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--border-primary)] p-4 text-sm text-[var(--text-muted)]">
          {emptyMessage}
        </div>
      ) : (
        <div className="space-y-3">
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
    <article className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h5 className="font-medium text-[var(--text-primary)]">{skill.title}</h5>
            <span className="rounded-full bg-[var(--bg-tertiary)] px-2 py-0.5 text-xs text-[var(--text-muted)]">
              {skill.name}
            </span>
          </div>
          {skill.description && (
            <p className="text-sm text-[var(--text-secondary)]">{skill.description}</p>
          )}
          <div className="text-xs font-mono text-[var(--text-muted)] break-all">{skill.path}</div>
        </div>

        <button
          onClick={() => void onReveal(skill.path)}
          disabled={revealing}
          className="flex-shrink-0 px-3 py-2 text-sm rounded-lg border border-[var(--border-primary)] hover:bg-[var(--bg-tertiary)] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {revealing ? 'Revealing...' : 'Reveal'}
        </button>
      </div>
    </article>
  );
}

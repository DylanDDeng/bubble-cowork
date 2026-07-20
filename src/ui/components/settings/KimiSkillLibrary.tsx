import { useEffect, useMemo, useState } from 'react';
import { LoaderCircle, RefreshCw } from '../icons';
import { useAppStore } from '../../store/useAppStore';
import type { ProviderListSkillsResult, ProviderSkillDescriptor } from '../../types';
import {
  CodexSkillDetailDialog,
  SkillListPane,
  stripMarkdownFrontmatter,
} from './CodexPluginLibrary';

const EMPTY_SKILLS_RESULT: ProviderListSkillsResult = {
  skills: [],
  source: 'empty',
  cached: false,
};

function normalizeRemoteErrorMessage(error: unknown, fallback: string): string {
  const rawMessage = error instanceof Error ? error.message : fallback;
  return rawMessage.replace(/^Error invoking remote method '[^']+':\s*/, '').trim();
}

function normalizeSearchText(value: string | undefined): string {
  return (value || '')
    .toLowerCase()
    .replace(/[:/_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function skillSearchBlob(skill: ProviderSkillDescriptor): string {
  return normalizeSearchText(
    [skill.name, skill.description, skill.scope].filter(Boolean).join('\n')
  );
}

/**
 * The "Kimi" tab of the skill library. Kimi has no plugin system — the kimi
 * server lists the skills KimiCore discovers (~/.agents/skills,
 * ~/.kimi-code/skills, plus builtins). Listings carry paths to SKILL.md
 * files, so the detail body loads through the generic skill-content reader.
 */
export function KimiSkillLibraryContent() {
  const { activeSessionId, sessions, projectCwd } = useAppStore();
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<ProviderListSkillsResult>(EMPTY_SKILLS_RESULT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [skillContent, setSkillContent] = useState<{
    path: string;
    content: string | null;
    error: string | null;
  } | null>(null);

  const activeSession = activeSessionId ? sessions[activeSessionId] : null;
  const discoveryCwd = activeSession?.cwd || projectCwd || undefined;
  const normalizedQuery = normalizeSearchText(query);

  const filteredSkills = useMemo(() => {
    if (!normalizedQuery) return result.skills;
    return result.skills.filter((skill) => skillSearchBlob(skill).includes(normalizedQuery));
  }, [normalizedQuery, result.skills]);

  const selectedSkill = useMemo(
    () => result.skills.find((skill) => skill.path === selectedPath) || null,
    [result.skills, selectedPath]
  );

  const loadSkills = async (forceReload = false) => {
    setLoading(true);
    setError(null);
    try {
      setResult(await window.electron.listKimiSkills({ cwd: discoveryCwd, forceReload }));
    } catch (loadError) {
      setResult(EMPTY_SKILLS_RESULT);
      setError(normalizeRemoteErrorMessage(loadError, 'Failed to load Kimi skills.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSkills();
  }, [discoveryCwd]);

  // Kimi listings carry the SKILL.md path but not its body — read it before
  // opening so the dialog has content on the first frame (codex flow).
  // Builtins report virtual builtin:// paths with no file behind them.
  const openSkillDetail = async (skill: ProviderSkillDescriptor) => {
    const path = skill.path;
    setSelectedPath(path);
    if (path.startsWith('builtin://')) {
      setSkillContent({
        path,
        content: null,
        error: 'Built-in Kimi skill — its instructions ship inside the Kimi runtime.',
      });
      setDetailOpen(true);
      return;
    }
    const load = window.electron
      .readCodexSkillContent(path)
      .then((readResult) => {
        setSkillContent({
          path,
          content:
            readResult.ok && readResult.content
              ? stripMarkdownFrontmatter(readResult.content)
              : null,
          error: readResult.ok ? null : readResult.message || 'Failed to read the skill file.',
        });
      })
      .catch((readError) => {
        setSkillContent({
          path,
          content: null,
          error: normalizeRemoteErrorMessage(readError, 'Failed to read the skill file.'),
        });
      });
    await Promise.race([load, new Promise((resolve) => setTimeout(resolve, 300))]);
    setDetailOpen(true);
  };

  return (
    <div className="space-y-4 pb-6">
      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={() => void loadSkills(true)}
          disabled={loading}
          className="inline-flex h-8 items-center gap-2 rounded-full border border-[var(--border)] px-3 text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          <span>Refresh</span>
        </button>
      </div>

      <SkillListPane
        skills={filteredSkills}
        loading={loading}
        error={error}
        discoveryCwd={discoveryCwd}
        query={query}
        subtitle="Extend Kimi with task-specific skills"
        onQueryChange={setQuery}
        onSelect={(skill) => void openSkillDetail(skill)}
      />

      <CodexSkillDetailDialog
        open={detailOpen}
        onOpenChange={setDetailOpen}
        skill={selectedSkill}
        content={skillContent}
        mentionPrefix="/skill:"
      />
    </div>
  );
}

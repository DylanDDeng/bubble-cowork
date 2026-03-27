import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import type { ProjectTreeNode } from '../types';
import {
  filterProjectFileSuggestions,
  flattenProjectTreeFiles,
  getProjectFileMentionState,
  type ProjectFileSuggestion,
} from '../utils/project-file-mentions';

export function useProjectFileMentions({
  cwd,
  prompt,
  cursorIndex,
}: {
  cwd?: string | null;
  prompt: string;
  cursorIndex: number;
}) {
  const { projectTree, projectTreeCwd, setProjectTree } = useAppStore();
  const [localTree, setLocalTree] = useState<ProjectTreeNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    const current = cwd?.trim() || '';
    if (!current) {
      setLocalTree(null);
      setLoading(false);
      return;
    }

    if (projectTreeCwd === current && projectTree) {
      setLocalTree(projectTree);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    window.electron
      .getProjectTree(current)
      .then((tree) => {
        if (cancelled) return;
        setLocalTree(tree);
        setProjectTree(current, tree);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [cwd, projectTree, projectTreeCwd, setProjectTree]);

  const files = useMemo(
    () => flattenProjectTreeFiles(localTree, cwd?.trim() || ''),
    [cwd, localTree]
  );

  const mention = useMemo(
    () => getProjectFileMentionState(prompt, cursorIndex),
    [cursorIndex, prompt]
  );

  const suggestions = useMemo(
    () => (mention ? filterProjectFileSuggestions(files, mention.query) : []),
    [files, mention]
  );

  useEffect(() => {
    setSelectedIndex(0);
  }, [mention?.query]);

  useEffect(() => {
    if (selectedIndex < suggestions.length) {
      return;
    }

    setSelectedIndex(0);
  }, [selectedIndex, suggestions.length]);

  return {
    loading,
    mention,
    hasMentionQuery: mention !== null,
    suggestions,
    selectedIndex,
    setSelectedIndex,
    moveSelection: (direction: 1 | -1) => {
      if (suggestions.length === 0) {
        return;
      }

      setSelectedIndex((current) => {
        const next = current + direction;
        if (next < 0) {
          return suggestions.length - 1;
        }
        if (next >= suggestions.length) {
          return 0;
        }
        return next;
      });
    },
    getCurrentSuggestion: (): ProjectFileSuggestion | null => suggestions[selectedIndex] || null,
  };
}

import { useEffect, useMemo, useState } from 'react';
import type { GitChangeEntry, ProjectTreeNode } from '../../shared/types';
import { useAppStore } from '../store/useAppStore';
import {
  DEFAULT_PROJECT_STARTER_PROMPTS,
  deriveProjectStarterPrompts,
} from '../utils/project-starter-prompts';

type GitChangeCacheEntry = {
  fetchedAt: number;
  entries: GitChangeEntry[];
};

const GIT_CHANGE_CACHE_TTL_MS = 30_000;
const gitChangeCache = new Map<string, GitChangeCacheEntry>();
const pendingGitChangeReads = new Map<string, Promise<GitChangeEntry[]>>();
const projectTreeCache = new Map<string, ProjectTreeNode | null>();
const pendingProjectTreeReads = new Map<string, Promise<ProjectTreeNode | null>>();

function readProjectTree(cwd: string): Promise<ProjectTreeNode | null> {
  if (projectTreeCache.has(cwd)) {
    return Promise.resolve(projectTreeCache.get(cwd) ?? null);
  }

  const pending = pendingProjectTreeReads.get(cwd);
  if (pending) return pending;

  const request = window.electron
    .getProjectTree(cwd)
    .catch(() => null)
    .then((tree) => {
      projectTreeCache.set(cwd, tree);
      return tree;
    })
    .finally(() => {
      pendingProjectTreeReads.delete(cwd);
    });
  pendingProjectTreeReads.set(cwd, request);
  return request;
}

function readProjectGitChanges(cwd: string): Promise<GitChangeEntry[]> {
  const cached = gitChangeCache.get(cwd);
  if (cached && Date.now() - cached.fetchedAt < GIT_CHANGE_CACHE_TTL_MS) {
    return Promise.resolve(cached.entries);
  }

  const pending = pendingGitChangeReads.get(cwd);
  if (pending) return pending;

  const request = window.electron
    .getGitChanges(cwd)
    .then((result) => result.ok ? result.entries : [])
    .catch(() => [])
    .then((entries) => {
      gitChangeCache.set(cwd, { fetchedAt: Date.now(), entries });
      return entries;
    })
    .finally(() => {
      pendingGitChangeReads.delete(cwd);
    });
  pendingGitChangeReads.set(cwd, request);
  return request;
}

export function useProjectStarterPrompts(cwd: string | null | undefined): string[] {
  const normalizedCwd = cwd?.trim() || '';
  const projectTreeCwd = useAppStore((state) => state.projectTreeCwd);
  const projectTree = useAppStore((state) => state.projectTree);
  const [localTree, setLocalTree] = useState<ProjectTreeNode | null>(() =>
    normalizedCwd ? projectTreeCache.get(normalizedCwd) ?? null : null
  );
  const [gitChanges, setGitChanges] = useState<GitChangeEntry[]>(() =>
    normalizedCwd ? gitChangeCache.get(normalizedCwd)?.entries ?? [] : []
  );

  useEffect(() => {
    if (!normalizedCwd) {
      setLocalTree(null);
      setGitChanges([]);
      return;
    }

    const matchingStoreTree = projectTreeCwd === normalizedCwd ? projectTree : null;
    if (matchingStoreTree) {
      projectTreeCache.set(normalizedCwd, matchingStoreTree);
      setLocalTree(matchingStoreTree);
    } else {
      setLocalTree(projectTreeCache.get(normalizedCwd) ?? null);
    }

    const cached = gitChangeCache.get(normalizedCwd);
    setGitChanges(cached?.entries ?? []);
    let active = true;
    void readProjectTree(normalizedCwd).then((tree) => {
      if (active) setLocalTree(tree);
    });
    void readProjectGitChanges(normalizedCwd).then((entries) => {
      if (active) setGitChanges(entries);
    });
    return () => {
      active = false;
    };
  }, [normalizedCwd, projectTree, projectTreeCwd]);

  return useMemo(() => {
    if (!normalizedCwd) return DEFAULT_PROJECT_STARTER_PROMPTS;
    return deriveProjectStarterPrompts({ tree: localTree, gitChanges });
  }, [gitChanges, localTree, normalizedCwd]);
}

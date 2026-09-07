import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GitOverviewResult } from '../../../shared/types';

const EMPTY_GIT_OVERVIEW: GitOverviewResult = {
  ok: false,
  error: null,
  hasRepo: false,
  repoRoot: null,
  repository: null,
  branch: null,
  upstream: null,
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  hasOriginRemote: false,
  isGitHubRemote: false,
  isDefaultBranch: false,
  totalChanges: 0,
  insertions: 0,
  deletions: 0,
  prStatus: 'not_found',
  pr: null,
};

export interface GitEnvironmentState {
  overview: GitOverviewResult;
  loading: boolean;
  lastUpdatedAt: number | null;
  refresh: () => Promise<void>;
  getSnapshot: () => GitEnvironmentSnapshot;
}

export interface GitEnvironmentSnapshot {
  contextKey: string;
  cwd: string | null;
  repoRoot: string | null;
  branch: string | null;
  signature: string;
}

function signatureFor(overview: GitOverviewResult): string {
  return [
    overview.repoRoot || '',
    overview.branch || '',
    overview.upstream || '',
    overview.aheadCount,
    overview.behindCount,
    overview.totalChanges,
    overview.insertions,
    overview.deletions,
    overview.prStatus,
    overview.pr?.number || '',
  ].join(':');
}

export function useGitEnvironment(cwd: string | null, contextKey: string): GitEnvironmentState {
  const [result, setResult] = useState({
    cwd,
    contextKey,
    overview: EMPTY_GIT_OVERVIEW,
    lastUpdatedAt: null as number | null,
  });
  const [pending, setPending] = useState(false);
  // A different workspace must never inherit the previous workspace's branch,
  // even for the render before its refresh effect starts.
  const isCurrent = result.cwd === cwd && result.contextKey === contextKey;
  const overview = isCurrent ? result.overview : EMPTY_GIT_OVERVIEW;
  const lastUpdatedAt = isCurrent ? result.lastUpdatedAt : null;
  const loading = Boolean(cwd) && (!isCurrent || pending);
  const requestSeqRef = useRef(0);
  const latestRef = useRef({
    cwd,
    contextKey,
    overview,
  });

  useEffect(() => {
    latestRef.current = { cwd, contextKey, overview };
  }, [contextKey, cwd, overview]);

  const refresh = useCallback(async () => {
    const trimmedCwd = (cwd || '').trim();
    const requestContextKey = contextKey;
    const requestId = requestSeqRef.current + 1;
    requestSeqRef.current = requestId;

    if (!trimmedCwd) {
      setResult({ cwd, contextKey, overview: EMPTY_GIT_OVERVIEW, lastUpdatedAt: null });
      setPending(false);
      return;
    }

    setPending(true);
    try {
      const next = await window.electron.getGitOverview(trimmedCwd);
      if (
        requestSeqRef.current !== requestId ||
        latestRef.current.contextKey !== requestContextKey ||
        latestRef.current.cwd !== cwd
      ) {
        return;
      }
      setResult({ cwd, contextKey, overview: next, lastUpdatedAt: Date.now() });
    } catch {
      if (requestSeqRef.current === requestId) {
        setResult({ cwd, contextKey, overview: { ...EMPTY_GIT_OVERVIEW, error: 'git-error' }, lastUpdatedAt: Date.now() });
      }
    } finally {
      if (requestSeqRef.current === requestId) {
        setPending(false);
      }
    }
  }, [contextKey, cwd]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => {
      void refresh();
    }, 60_000);

    const handleFocus = () => {
      void refresh();
    };
    window.addEventListener('focus', handleFocus);

    return () => {
      requestSeqRef.current += 1;
      window.clearInterval(interval);
      window.removeEventListener('focus', handleFocus);
    };
  }, [refresh]);

  const getSnapshot = useCallback<GitEnvironmentState['getSnapshot']>(() => {
    const current = latestRef.current;
    return {
      contextKey: current.contextKey,
      cwd: current.cwd || null,
      repoRoot: current.overview.repoRoot,
      branch: current.overview.branch,
      signature: signatureFor(current.overview),
    };
  }, []);

  return useMemo(
    () => ({
      overview,
      loading,
      lastUpdatedAt,
      refresh,
      getSnapshot,
    }),
    [getSnapshot, lastUpdatedAt, loading, overview, refresh]
  );
}

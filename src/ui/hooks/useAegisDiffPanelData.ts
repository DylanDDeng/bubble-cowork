import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GitCommitSummary } from '../../shared/types';
import type { GitPatchResult, ReviewDiffSelection, SessionView } from '../types';
import type { ChangeRecord } from '../utils/change-records';
import {
  parseRecordPatch,
  parseWorkspacePatch,
  summarizeDiffFiles,
  type AegisDiffFile,
} from '../utils/aegis-diff-rendering';
import { buildTurnChangeContext, type TurnChangeSummary } from '../utils/turn-change-records';
import {
  DEFAULT_REVIEW_DIFF_SELECTION,
  getTurnDiffKey,
  getTurnDiffLabel,
  getTurnMenuLabel,
} from '../utils/review-diff-selection';

export interface AegisDiffTurnOption {
  key: string;
  label: string;
  summary: TurnChangeSummary;
  current: boolean;
}

export interface AegisDiffPanelData {
  selection: ReviewDiffSelection;
  files: AegisDiffFile[];
  patch: string;
  loading: boolean;
  error: string | null;
  parseError: string | null;
  gitResult: GitPatchResult | null;
  turns: AegisDiffTurnOption[];
  commits: GitCommitSummary[];
  summary: {
    totalFiles: number;
    addedLines: number;
    removedLines: number;
  };
  refresh: () => void;
}

function getTurnRecords(selection: ReviewDiffSelection): ChangeRecord[] {
  return selection.source.kind === 'turn' ? selection.records || [] : [];
}

export function useAegisDiffPanelData({
  cwd,
  session,
  selection,
  active,
}: {
  cwd: string | null;
  session: SessionView | null;
  selection: ReviewDiffSelection | null;
  active: boolean;
}): AegisDiffPanelData {
  const [reloadToken, setReloadToken] = useState(0);
  const requestIdRef = useRef(0);
  const inFlightWorkspaceKeyRef = useRef<string | null>(null);
  const [workspaceState, setWorkspaceState] = useState<{
    cacheKey: string | null;
    files: AegisDiffFile[];
    patch: string;
    loading: boolean;
    error: string | null;
    parseError: string | null;
    gitResult: GitPatchResult | null;
  }>({
    cacheKey: null,
    files: [],
    patch: '',
    loading: false,
    error: null,
    parseError: null,
    gitResult: null,
  });

  const turnOptions = useMemo<AegisDiffTurnOption[]>(() => {
    const context = buildTurnChangeContext(session?.messages || []);
    const currentKey = context.turns.length > 0
      ? getTurnDiffKey(context.turns[context.turns.length - 1])
      : null;
    return context.turns.map((summary) => ({
      key: getTurnDiffKey(summary),
      label: getTurnMenuLabel(summary),
      summary,
      current: getTurnDiffKey(summary) === currentKey,
    }));
  }, [session?.messages]);

  // Until the user picks a source explicitly, default to the last captured
  // turn's diff (what the agent just changed); fall back to Uncommitted when
  // the session has no captured turns.
  const defaultSelection = useMemo<ReviewDiffSelection>(() => {
    const lastTurn = turnOptions.length > 0 ? turnOptions[turnOptions.length - 1] : null;
    if (!lastTurn) {
      return DEFAULT_REVIEW_DIFF_SELECTION;
    }
    return {
      source: {
        kind: 'turn',
        turnKey: lastTurn.key,
        label: getTurnDiffLabel(lastTurn.summary),
        sessionId: session?.id ?? null,
      },
      records: lastTurn.summary.records,
      selectedRecordId: lastTurn.summary.records[0]?.id ?? null,
      selectedFilePath: lastTurn.summary.records[0]?.filePath ?? null,
      requestedAt: 0,
    };
  }, [session?.id, turnOptions]);
  const effectiveSelection = selection || defaultSelection;

  const turnData = useMemo(() => {
    const source = effectiveSelection.source;
    if (source.kind !== 'turn') {
      return null;
    }
    const liveTurn = turnOptions.find((entry) => entry.key === source.turnKey);
    // Prefer the runner's whole-tree git diff for the turn: it captures MCP /
    // terminal edits that tool-change records miss. Fall back to records for
    // sessions/turns without a snapshot (non-git cwd, other providers).
    const gitPatch = liveTurn?.summary.gitPatch;
    if (gitPatch && gitPatch.trim()) {
      return parseWorkspacePatch(gitPatch);
    }
    return parseRecordPatch(liveTurn?.summary.records || getTurnRecords(effectiveSelection));
  }, [effectiveSelection, turnOptions]);

  const workspaceScope = effectiveSelection.source.kind === 'workspace'
    ? effectiveSelection.source.scope
    : null;
  const commitSha = effectiveSelection.source.kind === 'commit'
    ? effectiveSelection.source.sha
    : null;
  // Workspace scopes and commit patches share one fetch pipeline; the key
  // distinguishes them so switching sources always refetches.
  const gitSourceKey = workspaceScope ? `scope:${workspaceScope}` : commitSha ? `commit:${commitSha}` : null;

  useEffect(() => {
    if (!active || !gitSourceKey) {
      return;
    }

    if (!cwd) {
      const noCwdKey = `no-cwd\0${gitSourceKey}\0${reloadToken}`;
      if (workspaceState.cacheKey === noCwdKey && !workspaceState.loading) {
        return;
      }
      setWorkspaceState((current) => ({
        ...current,
        cacheKey: noCwdKey,
        files: [],
        patch: '',
        loading: false,
        error: 'no-cwd',
        parseError: null,
        gitResult: null,
      }));
      return;
    }

    const requestKey = `${cwd}\0${gitSourceKey}\0${reloadToken}`;
    if (workspaceState.cacheKey === requestKey && !workspaceState.loading) {
      return;
    }
    if (inFlightWorkspaceKeyRef.current === requestKey) {
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    inFlightWorkspaceKeyRef.current = requestKey;
    setWorkspaceState((current) => ({ ...current, loading: true, error: null }));

    const fetchPatch: Promise<GitPatchResult> = workspaceScope
      ? window.electron.getGitPatch(cwd, workspaceScope)
      : window.electron.getGitCommitPatch(cwd, commitSha as string).then((commitResult) => ({
          // Adapt to the workspace result shape; only ok/error/patch/truncated
          // are consumed downstream.
          ok: commitResult.ok,
          error: commitResult.error,
          scope: 'working-tree' as const,
          patch: commitResult.patch,
          repoRoot: commitResult.repoRoot,
          truncated: commitResult.truncated,
        }));

    void fetchPatch
      .then((result) => {
        if (requestIdRef.current !== requestId) return;
        inFlightWorkspaceKeyRef.current = null;
        if (!result.ok) {
          setWorkspaceState((current) => ({
            ...current,
            cacheKey: requestKey,
            files: [],
            patch: '',
            loading: false,
            error: result.error || 'git-error',
            parseError: null,
            gitResult: result,
          }));
          return;
        }

        const parsed = parseWorkspacePatch(result.patch);
        setWorkspaceState({
          cacheKey: requestKey,
          files: parsed.files,
          patch: parsed.patch,
          loading: false,
          error: null,
          parseError: parsed.parseError,
          gitResult: result,
        });
      })
      .catch((error) => {
        if (requestIdRef.current !== requestId) return;
        inFlightWorkspaceKeyRef.current = null;
        setWorkspaceState((current) => ({
          ...current,
          cacheKey: requestKey,
          loading: false,
          error: error instanceof Error ? error.message : 'git-error',
          gitResult: null,
        }));
      });
  }, [active, commitSha, cwd, gitSourceKey, reloadToken, workspaceScope, workspaceState.cacheKey, workspaceState.loading]);

  // Recent commits feed the "Committed" submenu of the scope dropdown.
  const [commits, setCommits] = useState<GitCommitSummary[]>([]);
  useEffect(() => {
    if (!active || !cwd) {
      setCommits([]);
      return;
    }
    let cancelled = false;
    void window.electron.getGitCommits(cwd, 20)
      .then((result) => {
        if (!cancelled) setCommits(result.ok ? result.commits : []);
      })
      .catch(() => {
        if (!cancelled) setCommits([]);
      });
    return () => {
      cancelled = true;
    };
  }, [active, cwd, reloadToken]);

  const refresh = useCallback(() => {
    setReloadToken((current) => current + 1);
  }, []);

  const files = turnData ? turnData.files : workspaceState.files;
  const patch = turnData ? turnData.patch : workspaceState.patch;
  const summary = useMemo(() => summarizeDiffFiles(files), [files]);

  return {
    selection: effectiveSelection,
    files,
    patch,
    loading: effectiveSelection.source.kind !== 'turn' ? workspaceState.loading : false,
    error: turnData ? null : workspaceState.error,
    parseError: turnData ? turnData.parseError : workspaceState.parseError,
    gitResult: turnData ? null : workspaceState.gitResult,
    turns: turnOptions,
    commits,
    summary,
    refresh,
  };
}

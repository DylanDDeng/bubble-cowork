import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  const effectiveSelection = selection || DEFAULT_REVIEW_DIFF_SELECTION;
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

  const turnData = useMemo(() => {
    if (effectiveSelection.source.kind !== 'turn') {
      return null;
    }
    const liveTurn = turnOptions.find((entry) => entry.key === effectiveSelection.source.turnKey);
    return parseRecordPatch(liveTurn?.summary.records || getTurnRecords(effectiveSelection));
  }, [effectiveSelection, turnOptions]);

  const workspaceScope = effectiveSelection.source.kind === 'workspace'
    ? effectiveSelection.source.scope
    : null;

  useEffect(() => {
    if (!active || !workspaceScope) {
      return;
    }

    if (!cwd) {
      const noCwdKey = `no-cwd\0${workspaceScope}\0${reloadToken}`;
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

    const requestKey = `${cwd}\0${workspaceScope}\0${reloadToken}`;
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

    void window.electron.getGitPatch(cwd, workspaceScope)
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
  }, [active, cwd, reloadToken, workspaceScope, workspaceState.cacheKey, workspaceState.loading]);

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
    loading: effectiveSelection.source.kind === 'workspace' ? workspaceState.loading : false,
    error: turnData ? null : workspaceState.error,
    parseError: turnData ? turnData.parseError : workspaceState.parseError,
    gitResult: turnData ? null : workspaceState.gitResult,
    turns: turnOptions,
    summary,
    refresh,
  };
}

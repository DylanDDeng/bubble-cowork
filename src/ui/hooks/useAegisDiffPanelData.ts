import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GitPatchResult, GitPatchScope, ReviewDiffSelection, SessionView } from '../types';
import type { ChangeRecord } from '../utils/change-records';
import {
  parseRecordPatch,
  parseWorkspacePatch,
  summarizeDiffFiles,
  type AegisDiffFile,
} from '../utils/aegis-diff-rendering';
import { buildTurnChangeContext, type TurnChangeSummary } from '../utils/turn-change-records';

export interface AegisDiffTurnOption {
  key: string;
  label: string;
  summary: TurnChangeSummary;
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

const DEFAULT_SELECTION: ReviewDiffSelection = {
  source: { kind: 'workspace', scope: 'working-tree', label: 'Working tree' },
  selectedRecordId: null,
  selectedFilePath: null,
  requestedAt: 0,
};

function turnKey(summary: TurnChangeSummary): string {
  return `turn:${summary.turnIndex}:${summary.firstMessageIndex}:${summary.lastMessageIndex}`;
}

function getTurnLabel(summary: TurnChangeSummary): string {
  return `Turn ${summary.turnIndex + 1}`;
}

function getWorkspaceLabel(scope: GitPatchScope): string {
  if (scope === 'working-tree') return 'Working tree';
  if (scope === 'unstaged') return 'Unstaged';
  if (scope === 'staged') return 'Staged';
  return 'Branch';
}

function getTurnRecords(selection: ReviewDiffSelection): ChangeRecord[] {
  return selection.source.kind === 'turn' ? selection.records || [] : [];
}

export function buildReviewTurnSelection(
  summary: TurnChangeSummary,
  sessionId: string | null,
  selectedRecord?: ChangeRecord | null
): ReviewDiffSelection {
  return {
    source: {
      kind: 'turn',
      turnKey: turnKey(summary),
      label: getTurnLabel(summary),
      sessionId,
    },
    records: summary.records,
    selectedRecordId: selectedRecord?.id ?? summary.records[0]?.id ?? null,
    selectedFilePath: selectedRecord?.filePath ?? summary.records[0]?.filePath ?? null,
    requestedAt: Date.now(),
  };
}

export function buildWorkspaceReviewSelection(scope: GitPatchScope): ReviewDiffSelection {
  return {
    source: {
      kind: 'workspace',
      scope,
      label: getWorkspaceLabel(scope),
    },
    selectedRecordId: null,
    selectedFilePath: null,
    requestedAt: Date.now(),
  };
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
  const effectiveSelection = selection || DEFAULT_SELECTION;
  const [reloadToken, setReloadToken] = useState(0);
  const requestIdRef = useRef(0);
  const [workspaceState, setWorkspaceState] = useState<{
    files: AegisDiffFile[];
    patch: string;
    loading: boolean;
    error: string | null;
    parseError: string | null;
    gitResult: GitPatchResult | null;
  }>({
    files: [],
    patch: '',
    loading: false,
    error: null,
    parseError: null,
    gitResult: null,
  });

  const turnOptions = useMemo<AegisDiffTurnOption[]>(() => {
    const context = buildTurnChangeContext(session?.messages || []);
    return context.turns.map((summary) => ({
      key: turnKey(summary),
      label: getTurnLabel(summary),
      summary,
    }));
  }, [session?.messages]);

  const turnData = useMemo(() => {
    if (effectiveSelection.source.kind !== 'turn') {
      return null;
    }
    return parseRecordPatch(getTurnRecords(effectiveSelection));
  }, [effectiveSelection]);

  useEffect(() => {
    if (!active || effectiveSelection.source.kind !== 'workspace') {
      return;
    }

    if (!cwd) {
      setWorkspaceState((current) => ({
        ...current,
        files: [],
        patch: '',
        loading: false,
        error: 'no-cwd',
        parseError: null,
        gitResult: null,
      }));
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setWorkspaceState((current) => ({ ...current, loading: true, error: null }));

    void window.electron.getGitPatch(cwd, effectiveSelection.source.scope)
      .then((result) => {
        if (requestIdRef.current !== requestId) return;
        if (!result.ok) {
          setWorkspaceState((current) => ({
            ...current,
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
        setWorkspaceState((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : 'git-error',
          gitResult: null,
        }));
      });
  }, [active, cwd, effectiveSelection, reloadToken]);

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

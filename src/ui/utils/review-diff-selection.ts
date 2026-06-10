import type { GitPatchScope, ReviewDiffSelection } from '../types';
import type { ChangeRecord } from './change-records';
import type { TurnChangeSummary } from './turn-change-records';

export const WORKSPACE_DIFF_SCOPES: Array<{ scope: GitPatchScope; label: string }> = [
  { scope: 'working-tree', label: 'Working tree' },
  { scope: 'unstaged', label: 'Unstaged' },
  { scope: 'staged', label: 'Staged' },
  { scope: 'branch', label: 'Branch' },
];

export const DEFAULT_REVIEW_DIFF_SELECTION: ReviewDiffSelection = {
  source: { kind: 'workspace', scope: 'working-tree', label: 'Working tree' },
  selectedRecordId: null,
  selectedFilePath: null,
  requestedAt: 0,
};

export function getWorkspaceDiffLabel(scope: GitPatchScope): string {
  return WORKSPACE_DIFF_SCOPES.find((entry) => entry.scope === scope)?.label || 'Working tree';
}

export function getTurnDiffKey(summary: TurnChangeSummary): string {
  return `turn:${summary.turnIndex}:${summary.firstMessageIndex}:${summary.lastMessageIndex}`;
}

export function getTurnDiffLabel(summary: TurnChangeSummary): string {
  return `Turn ${summary.turnIndex + 1} changes`;
}

export function getTurnMenuLabel(summary: TurnChangeSummary): string {
  return `Turn ${summary.turnIndex + 1}`;
}

export function buildReviewTurnSelection(
  summary: TurnChangeSummary,
  sessionId: string | null,
  selectedRecord?: ChangeRecord | null
): ReviewDiffSelection {
  return {
    source: {
      kind: 'turn',
      turnKey: getTurnDiffKey(summary),
      label: getTurnDiffLabel(summary),
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
      label: getWorkspaceDiffLabel(scope),
    },
    selectedRecordId: null,
    selectedFilePath: null,
    requestedAt: Date.now(),
  };
}

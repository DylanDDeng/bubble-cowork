import type { GitCommitSummary } from '../../shared/types';
import type { GitPatchScope, ReviewDiffSelection } from '../types';
import type { ChangeRecord } from './change-records';
import type { TurnChangeSummary } from './turn-change-records';

// "Uncommitted" (the working-tree scope) is the parent of Unstaged/Staged in
// the scope dropdown; the git scope key stays `working-tree` for IPC parity.
export const WORKSPACE_DIFF_SCOPES: Array<{ scope: GitPatchScope; label: string }> = [
  { scope: 'working-tree', label: 'Uncommitted' },
  { scope: 'unstaged', label: 'Unstaged' },
  { scope: 'staged', label: 'Staged' },
  { scope: 'branch', label: 'Branch' },
];

export const DEFAULT_REVIEW_DIFF_SELECTION: ReviewDiffSelection = {
  source: { kind: 'workspace', scope: 'working-tree', label: 'Uncommitted' },
  selectedRecordId: null,
  selectedFilePath: null,
  requestedAt: 0,
};

export function getWorkspaceDiffLabel(scope: GitPatchScope): string {
  return WORKSPACE_DIFF_SCOPES.find((entry) => entry.scope === scope)?.label || 'Uncommitted';
}

export function getCommitDiffLabel(commit: Pick<GitCommitSummary, 'shortSha' | 'subject'>): string {
  return commit.subject ? `${commit.shortSha} · ${commit.subject}` : commit.shortSha;
}

export function buildCommitReviewSelection(commit: GitCommitSummary): ReviewDiffSelection {
  return {
    source: {
      kind: 'commit',
      sha: commit.sha,
      shortSha: commit.shortSha,
      label: getCommitDiffLabel(commit),
    },
    selectedRecordId: null,
    selectedFilePath: null,
    requestedAt: Date.now(),
  };
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

import { parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs';
import type { ChangeRecord } from './change-records';

export type AegisDiffRenderMode = 'unified' | 'split';

export interface AegisDiffFile {
  key: string;
  path: string;
  name: string;
  status: string;
  addedLines: number;
  removedLines: number;
  record?: ChangeRecord;
  diff?: FileDiffMetadata;
  hasDiff: boolean;
}

export interface AegisDiffParseResult {
  files: AegisDiffFile[];
  patch: string;
  parseError: string | null;
}

function normalizePath(filePath: string): string {
  return filePath.replaceAll('\\', '/').replace(/^["']|["']$/g, '');
}

export function basenameOfDiffPath(filePath: string): string {
  const normalized = normalizePath(filePath);
  const parts = normalized.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : normalized;
}

function isCreateOperation(record: ChangeRecord): boolean {
  return record.operation === 'write' || record.operation === 'added' || record.operation === 'untracked';
}

function isDeleteOperation(record: ChangeRecord): boolean {
  return record.operation === 'delete' || record.operation === 'deleted';
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}

export function createPatchFromChangeRecord(record: ChangeRecord): string {
  const diffContent = record.diffContent?.trim();
  if (!diffContent) return '';

  if (diffContent.startsWith('diff --git ')) {
    return ensureTrailingNewline(diffContent);
  }

  const normalizedPath = normalizePath(record.filePath);
  const header = [
    `diff --git a/${normalizedPath} b/${normalizedPath}`,
    ...(isCreateOperation(record) ? ['new file mode 100644'] : []),
    ...(isDeleteOperation(record) ? ['deleted file mode 100644'] : []),
    isCreateOperation(record) ? '--- /dev/null' : `--- a/${normalizedPath}`,
    isDeleteOperation(record) ? '+++ /dev/null' : `+++ b/${normalizedPath}`,
  ];

  return ensureTrailingNewline([...header, diffContent].join('\n'));
}

export function createPatchFromChangeRecords(records: ChangeRecord[]): string {
  return records
    .map(createPatchFromChangeRecord)
    .filter((patch) => patch.trim().length > 0)
    .join('\n');
}

function diffPath(fileDiff: FileDiffMetadata): string {
  const name = normalizePath(fileDiff.name || fileDiff.prevName || '');
  if (name && name !== '/dev/null') return name;
  return normalizePath(fileDiff.prevName || name);
}

function diffStats(fileDiff: FileDiffMetadata): { addedLines: number; removedLines: number } {
  let addedLines = 0;
  let removedLines = 0;
  for (const hunk of fileDiff.hunks) {
    addedLines += hunk.additionCount || 0;
    removedLines += hunk.deletionCount || 0;
  }
  return { addedLines, removedLines };
}

function statusFromDiff(fileDiff: FileDiffMetadata): string {
  if (fileDiff.type === 'new') return 'A';
  if (fileDiff.type === 'deleted') return 'D';
  if (fileDiff.type === 'rename-pure' || fileDiff.type === 'rename-changed') return 'R';
  return 'M';
}

function fileFromDiff(fileDiff: FileDiffMetadata, index: number, record?: ChangeRecord): AegisDiffFile {
  const path = record?.filePath ? normalizePath(record.filePath) : diffPath(fileDiff);
  const stats = diffStats(fileDiff);
  return {
    key: record?.id || `${path}:${index}`,
    path,
    name: basenameOfDiffPath(path),
    status: record?.status || statusFromDiff(fileDiff),
    addedLines: record?.addedLines ?? stats.addedLines,
    removedLines: record?.removedLines ?? stats.removedLines,
    record,
    diff: fileDiff,
    hasDiff: true,
  };
}

function fileFromRecord(record: ChangeRecord): AegisDiffFile {
  return {
    key: record.id,
    path: normalizePath(record.filePath),
    name: record.fileName || basenameOfDiffPath(record.filePath),
    status: record.status,
    addedLines: record.addedLines,
    removedLines: record.removedLines,
    record,
    hasDiff: false,
  };
}

function parsePatch(patch: string): { files: FileDiffMetadata[]; error: string | null } {
  if (!patch.trim()) {
    return { files: [], error: null };
  }

  try {
    const parsed = parsePatchFiles(patch, 'aegis-review');
    return {
      files: parsed.flatMap((entry) => entry.files),
      error: null,
    };
  } catch (error) {
    return {
      files: [],
      error: error instanceof Error ? error.message : 'Unable to parse patch.',
    };
  }
}

export function parseWorkspacePatch(patch: string): AegisDiffParseResult {
  const parsed = parsePatch(patch);
  return {
    files: parsed.files.map((fileDiff, index) => fileFromDiff(fileDiff, index)),
    patch,
    parseError: parsed.error,
  };
}

export function parseRecordPatch(records: ChangeRecord[]): AegisDiffParseResult {
  const patch = createPatchFromChangeRecords(records);
  const parsed = parsePatch(patch);
  const recordsByPath = new Map(records.map((record) => [normalizePath(record.filePath), record]));
  const usedRecordIds = new Set<string>();
  const files = parsed.files.map((fileDiff, index) => {
    const path = diffPath(fileDiff);
    const record = recordsByPath.get(path);
    if (record) usedRecordIds.add(record.id);
    return fileFromDiff(fileDiff, index, record);
  });

  for (const record of records) {
    if (!usedRecordIds.has(record.id)) {
      files.push(fileFromRecord(record));
    }
  }

  return {
    files,
    patch,
    parseError: parsed.error,
  };
}

export function summarizeDiffFiles(files: AegisDiffFile[]): {
  totalFiles: number;
  addedLines: number;
  removedLines: number;
} {
  return files.reduce(
    (summary, file) => ({
      totalFiles: summary.totalFiles + 1,
      addedLines: summary.addedLines + file.addedLines,
      removedLines: summary.removedLines + file.removedLines,
    }),
    { totalFiles: 0, addedLines: 0, removedLines: 0 }
  );
}

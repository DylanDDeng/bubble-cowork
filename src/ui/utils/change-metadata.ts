export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | '?';

export interface UnifiedDiffSummary {
  filesChanged: number;
  hunks: number;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface ChangeMetadataInput {
  filePath: string;
  status: ChangeStatus;
  staged?: boolean;
  sizeBytes?: number;
  currentText?: string | null;
  previousText?: string | null;
  diffText?: string | null;
}

export interface ChangeMetadata {
  fileName: string;
  extension: string;
  statusLabel: string;
  statusDetail: string;
  sizeLabel: string | null;
  lineCountLabel: string | null;
  diffSummaryLabel: string | null;
  summary: UnifiedDiffSummary | null;
}

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function fileNameFromPath(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/').split('?')[0]?.split('#')[0] || '';
  const parts = normalized.split('/');
  return parts[parts.length - 1] || filePath;
}

export function extensionFromPath(filePath: string): string {
  const fileName = fileNameFromPath(filePath);
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : '';
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < SIZE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const rounded = unitIndex === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${rounded} ${SIZE_UNITS[unitIndex]}`;
}

export function countLines(text: string | null | undefined): number {
  if (!isNonEmptyString(text)) {
    return 0;
  }

  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalized) {
    return 0;
  }

  return normalized.split('\n').length;
}

export function formatLineCount(lines: number): string {
  if (!Number.isFinite(lines) || lines <= 0) {
    return '0 lines';
  }
  return lines === 1 ? '1 line' : `${lines} lines`;
}

function isDiffBodyLine(line: string): boolean {
  if (!line) return false;
  if (line.startsWith('+++ ') || line.startsWith('--- ')) return false;
  if (line.startsWith('diff --git ')) return false;
  if (line.startsWith('index ')) return false;
  if (line.startsWith('new file mode ')) return false;
  if (line.startsWith('deleted file mode ')) return false;
  if (line.startsWith('similarity index ')) return false;
  if (line.startsWith('rename from ')) return false;
  if (line.startsWith('rename to ')) return false;
  if (line.startsWith('Binary files ')) return false;
  if (line.startsWith('GIT binary patch')) return false;
  if (line.startsWith('\\ No newline at end of file')) return false;
  return true;
}

export function parseUnifiedDiffSummary(diffText: string | null | undefined): UnifiedDiffSummary | null {
  if (!isNonEmptyString(diffText)) {
    return null;
  }

  const normalized = diffText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');

  let filesChanged = 0;
  let hunks = 0;
  let additions = 0;
  let deletions = 0;
  let binary = false;
  let sawDiffContent = false;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      filesChanged += 1;
      sawDiffContent = true;
      continue;
    }

    if (line.startsWith('@@ ')) {
      hunks += 1;
      sawDiffContent = true;
      continue;
    }

    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      binary = true;
      sawDiffContent = true;
      continue;
    }

    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      sawDiffContent = true;
      continue;
    }

    if (!isDiffBodyLine(line)) {
      continue;
    }

    if (line.startsWith('+')) {
      additions += 1;
      sawDiffContent = true;
      continue;
    }

    if (line.startsWith('-')) {
      deletions += 1;
      sawDiffContent = true;
    }
  }

  if (!filesChanged && !hunks && !additions && !deletions && !binary) {
    return null;
  }

  if (!filesChanged && sawDiffContent) {
    filesChanged = 1;
  }

  return { filesChanged, hunks, additions, deletions, binary };
}

export function formatUnifiedDiffSummary(summary: UnifiedDiffSummary | null): string | null {
  if (!summary) {
    return null;
  }

  const parts: string[] = [];
  if (summary.filesChanged > 0) {
    parts.push(summary.filesChanged === 1 ? '1 file' : `${summary.filesChanged} files`);
  }
  if (summary.hunks > 0) {
    parts.push(summary.hunks === 1 ? '1 hunk' : `${summary.hunks} hunks`);
  }
  if (summary.additions > 0 || summary.deletions > 0) {
    const delta = [];
    if (summary.additions > 0) delta.push(`+${summary.additions}`);
    if (summary.deletions > 0) delta.push(`-${summary.deletions}`);
    parts.push(delta.join('/'));
  }
  if (summary.binary) {
    parts.push('binary');
  }

  return parts.length > 0 ? parts.join(' | ') : null;
}

export function formatChangeStatus(status: ChangeStatus, staged = false): { label: string; detail: string } {
  switch (status) {
    case 'A':
      return { label: 'Added', detail: staged ? 'Staged new file' : 'New file' };
    case 'D':
      return { label: 'Deleted', detail: staged ? 'Staged deletion' : 'Deleted file' };
    case 'R':
      return { label: 'Renamed', detail: staged ? 'Staged rename' : 'Renamed file' };
    case '?':
      return { label: 'Untracked', detail: 'Not tracked by git' };
    case 'M':
    default:
      return { label: 'Modified', detail: staged ? 'Staged change' : 'Working tree change' };
  }
}

export function buildChangeMetadata(input: ChangeMetadataInput): ChangeMetadata {
  const fileName = fileNameFromPath(input.filePath);
  const extension = extensionFromPath(input.filePath);
  const status = formatChangeStatus(input.status, input.staged);
  const sizeLabel =
    Number.isFinite(input.sizeBytes ?? Number.NaN) && (input.sizeBytes ?? 0) >= 0
      ? formatBytes(input.sizeBytes ?? 0)
      : null;

  const lineCount =
    countLines(input.currentText) ||
    countLines(input.previousText);
  const lineCountLabel = lineCount > 0 ? formatLineCount(lineCount) : null;

  const summary = parseUnifiedDiffSummary(input.diffText);
  const diffSummaryLabel = formatUnifiedDiffSummary(summary);

  return {
    fileName,
    extension,
    statusLabel: status.label,
    statusDetail: status.detail,
    sizeLabel,
    lineCountLabel,
    diffSummaryLabel,
    summary,
  };
}

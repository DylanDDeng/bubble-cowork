import { createUnifiedDiffHunks, formatUnifiedDiffHunks, parseUnifiedDiff } from '../../../../shared/unified-diff';

function normalizeDiffPath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

export function createToolUnifiedDiff(filePath: string, oldText: string, newText: string): string {
  const hunks = createUnifiedDiffHunks(oldText, newText, { contextLines: 3 });
  const body = formatUnifiedDiffHunks(hunks);
  if (!body.trim()) {
    return '';
  }

  const normalized = normalizeDiffPath(filePath);
  return [
    `--- a/${normalized}`,
    `+++ b/${normalized}`,
    body,
  ].join('\n');
}

export function countDiffChanges(diff: string): { addedLines: number; removedLines: number } {
  const hunks = parseUnifiedDiff(diff);
  let addedLines = 0;
  let removedLines = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'addition') addedLines += 1;
      if (line.type === 'deletion') removedLines += 1;
    }
  }
  return { addedLines, removedLines };
}

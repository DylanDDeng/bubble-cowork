export type UnifiedDiffLineType = 'context' | 'addition' | 'deletion';

export interface UnifiedDiffLine {
  type: UnifiedDiffLineType;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  text: string;
}

export interface UnifiedDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: UnifiedDiffLine[];
}

export interface UnifiedDiffOptions {
  contextLines?: number;
}

type DiffOp =
  | { type: 'equal'; text: string }
  | { type: 'insert'; text: string }
  | { type: 'delete'; text: string };

type AnnotatedDiffOp = DiffOp & {
  oldLineNumber: number;
  newLineNumber: number;
};

const DEFAULT_CONTEXT_LINES = 3;

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function splitLines(text: string): string[] {
  if (!text) return [];

  const lines = normalizeText(text).split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines;
}

function buildLcsTable(oldLines: string[], newLines: string[]): Uint32Array {
  const rows = oldLines.length + 1;
  const cols = newLines.length + 1;
  const table = new Uint32Array(rows * cols);

  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      const current = oldIndex * cols + newIndex;
      if (oldLines[oldIndex] === newLines[newIndex]) {
        table[current] = table[(oldIndex + 1) * cols + (newIndex + 1)] + 1;
      } else {
        const down = table[(oldIndex + 1) * cols + newIndex];
        const right = table[oldIndex * cols + (newIndex + 1)];
        table[current] = down >= right ? down : right;
      }
    }
  }

  return table;
}

function diffLines(oldLines: string[], newLines: string[]): DiffOp[] {
  const cols = newLines.length + 1;
  const table = buildLcsTable(oldLines, newLines);
  const ops: DiffOp[] = [];

  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      ops.push({ type: 'equal', text: oldLines[oldIndex] });
      oldIndex += 1;
      newIndex += 1;
      continue;
    }

    const down = table[(oldIndex + 1) * cols + newIndex];
    const right = table[oldIndex * cols + (newIndex + 1)];
    if (down >= right) {
      ops.push({ type: 'delete', text: oldLines[oldIndex] });
      oldIndex += 1;
    } else {
      ops.push({ type: 'insert', text: newLines[newIndex] });
      newIndex += 1;
    }
  }

  while (oldIndex < oldLines.length) {
    ops.push({ type: 'delete', text: oldLines[oldIndex] });
    oldIndex += 1;
  }

  while (newIndex < newLines.length) {
    ops.push({ type: 'insert', text: newLines[newIndex] });
    newIndex += 1;
  }

  return ops;
}

function annotateOps(ops: DiffOp[]): AnnotatedDiffOp[] {
  const annotated: AnnotatedDiffOp[] = [];
  let oldLineNumber = 1;
  let newLineNumber = 1;

  for (const op of ops) {
    annotated.push({
      ...op,
      oldLineNumber,
      newLineNumber,
    });

    if (op.type === 'equal') {
      oldLineNumber += 1;
      newLineNumber += 1;
    } else if (op.type === 'delete') {
      oldLineNumber += 1;
    } else {
      newLineNumber += 1;
    }
  }

  return annotated;
}

function countConsumedLines(ops: AnnotatedDiffOp[]): { oldLines: number; newLines: number } {
  let oldLines = 0;
  let newLines = 0;

  for (const op of ops) {
    if (op.type !== 'insert') {
      oldLines += 1;
    }
    if (op.type !== 'delete') {
      newLines += 1;
    }
  }

  return { oldLines, newLines };
}

function createHunk(ops: AnnotatedDiffOp[]): UnifiedDiffHunk {
  const { oldLines, newLines } = countConsumedLines(ops);
  const first = ops[0];

  return {
    oldStart: first.oldLineNumber,
    oldLines,
    newStart: first.newLineNumber,
    newLines,
    lines: ops.map((op) => ({
      type: op.type === 'equal' ? 'context' : op.type === 'insert' ? 'addition' : 'deletion',
      oldLineNumber: op.type === 'insert' ? null : op.oldLineNumber,
      newLineNumber: op.type === 'delete' ? null : op.newLineNumber,
      text: op.text,
    })),
  };
}

function splitIntoHunks(ops: AnnotatedDiffOp[], contextLines: number): UnifiedDiffHunk[] {
  const hunks: UnifiedDiffHunk[] = [];
  const editIndexes: number[] = [];

  for (let index = 0; index < ops.length; index += 1) {
    if (ops[index].type !== 'equal') {
      editIndexes.push(index);
    }
  }

  if (editIndexes.length === 0) {
    return hunks;
  }

  let groupStart = editIndexes[0];
  let groupEnd = editIndexes[0];

  const finalizeGroup = () => {
    const start = Math.max(0, groupStart - contextLines);
    const end = Math.min(ops.length - 1, groupEnd + contextLines);
    hunks.push(createHunk(ops.slice(start, end + 1)));
  };

  for (let index = 1; index < editIndexes.length; index += 1) {
    const nextEditIndex = editIndexes[index];
    const gap = nextEditIndex - groupEnd - 1;

    // Keep nearby edits together when the surrounding context would overlap.
    if (gap <= contextLines * 2) {
      groupEnd = nextEditIndex;
    } else {
      finalizeGroup();
      groupStart = nextEditIndex;
      groupEnd = nextEditIndex;
    }
  }

  finalizeGroup();
  return hunks;
}

export function createUnifiedDiffHunks(
  oldText: string,
  newText: string,
  options: UnifiedDiffOptions = {}
): UnifiedDiffHunk[] {
  const contextLines = Math.max(0, Math.floor(options.contextLines ?? DEFAULT_CONTEXT_LINES));
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  if (oldLines.length === 0 && newLines.length === 0) {
    return [];
  }

  const ops = diffLines(oldLines, newLines);
  const annotated = annotateOps(ops);
  return splitIntoHunks(annotated, contextLines);
}

function formatHunkHeader(hunk: UnifiedDiffHunk): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
}

export function formatUnifiedDiffHunks(hunks: UnifiedDiffHunk[]): string {
  return hunks
    .map((hunk) => {
      const lines = hunk.lines.map((line) => {
        if (line.type === 'context') return ` ${line.text}`;
        if (line.type === 'addition') return `+${line.text}`;
        return `-${line.text}`;
      });

      return [formatHunkHeader(hunk), ...lines].join('\n');
    })
    .join('\n');
}

export function extractUnifiedDiffFilePath(diffContent: string): string | null {
  const normalized = normalizeText(diffContent);

  const indexMatch = normalized.match(/^Index:\s+(.+)$/m);
  if (indexMatch?.[1]?.trim()) {
    return indexMatch[1].trim();
  }

  const plusMatch = normalized.match(/^\+\+\+\s+(.+)$/m);
  if (plusMatch?.[1]?.trim() && plusMatch[1].trim() !== '/dev/null') {
    return plusMatch[1].replace(/^b\//, '').trim();
  }

  const minusMatch = normalized.match(/^---\s+(.+)$/m);
  if (minusMatch?.[1]?.trim() && minusMatch[1].trim() !== '/dev/null') {
    return minusMatch[1].replace(/^a\//, '').trim();
  }

  return null;
}

export function parseUnifiedDiff(diffContent: string): UnifiedDiffHunk[] {
  const lines = normalizeText(diffContent).split('\n');
  const hunks: UnifiedDiffHunk[] = [];
  let currentHunk: UnifiedDiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  const pushCurrentHunk = () => {
    if (currentHunk) {
      hunks.push(currentHunk);
      currentHunk = null;
    }
  };

  for (const line of lines) {
    const headerMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (headerMatch) {
      pushCurrentHunk();
      oldLine = Number(headerMatch[1]);
      newLine = Number(headerMatch[3]);
      currentHunk = {
        oldStart: oldLine,
        oldLines: Number(headerMatch[2] || 1),
        newStart: newLine,
        newLines: Number(headerMatch[4] || 1),
        lines: [],
      };
      continue;
    }

    if (!currentHunk) {
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      currentHunk.lines.push({
        type: 'addition',
        oldLineNumber: null,
        newLineNumber: newLine,
        text: line.slice(1),
      });
      newLine += 1;
      continue;
    }

    if (line.startsWith('-') && !line.startsWith('---')) {
      currentHunk.lines.push({
        type: 'deletion',
        oldLineNumber: oldLine,
        newLineNumber: null,
        text: line.slice(1),
      });
      oldLine += 1;
      continue;
    }

    if (line.startsWith(' ')) {
      currentHunk.lines.push({
        type: 'context',
        oldLineNumber: oldLine,
        newLineNumber: newLine,
        text: line.slice(1),
      });
      oldLine += 1;
      newLine += 1;
      continue;
    }
  }

  pushCurrentHunk();
  return hunks;
}

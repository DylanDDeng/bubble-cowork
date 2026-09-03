import type { StreamMessage, ContentBlock } from '../types';
import {
  getMessageContentBlocks,
  normalizeToolResultBlock,
  normalizeToolUseBlock,
} from './message-content';
import {
  createUnifiedDiffHunks,
  extractUnifiedDiffFilePath,
  formatUnifiedDiffHunks,
} from './unified-diff';

export type GitChangeEntry = {
  filePath: string;
  status: string;
  staged: boolean;
};

export type ChangeOperation =
  | 'bash'
  | 'write'
  | 'edit'
  | 'delete'
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked';

export type ChangeRecordSource = 'tool' | 'git';
export type ChangeRecordState = 'pending' | 'success';

export interface ChangeRecord {
  id: string;
  filePath: string;
  fileName: string;
  dirPath: string;
  status: string;
  staged: boolean;
  source: ChangeRecordSource;
  operation: ChangeOperation;
  state: ChangeRecordState;
  order: number;
  toolUseId?: string;
  diffContent: string | null;
  sizeBytes: number | null;
  lineCount: number | null;
  addedLines: number;
  removedLines: number;
}

type ToolResultBlock = ContentBlock & { type: 'tool_result' };
type ToolUseBlock = ContentBlock & { type: 'tool_use' };

const textEncoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function getFirstString(input: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = getString(input[key]);
    if (value) return value;
  }
  return null;
}

function normalizePath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function splitPath(filePath: string): { fileName: string; dirPath: string } {
  const normalized = normalizePath(filePath);
  const fileName = normalized.split('/').pop() || normalized;
  const dirPath = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '';
  return { fileName, dirPath };
}

function splitTextLines(text: string): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function countLines(text: string): number {
  return splitTextLines(text).length;
}

function byteLength(text: string): number {
  return textEncoder.encode(text).length;
}

function countDiffStats(diffContent: string): { addedLines: number; removedLines: number } {
  let addedLines = 0;
  let removedLines = 0;

  for (const line of diffContent.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      addedLines += 1;
    } else if (line.startsWith('-')) {
      removedLines += 1;
    }
  }

  return { addedLines, removedLines };
}

function createWriteDiff(filePath: string, content: string): string {
  const normalized = normalizePath(filePath);
  const lines = splitTextLines(content);
  const diffLines = [
    `diff --git a/${normalized} b/${normalized}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${normalized}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ];

  return diffLines.join('\n');
}

function extractDiffHunkBody(diffContent: string): string {
  const normalized = diffContent.trim();
  if (!normalized) return '';

  const hunkIndex = normalized.indexOf('@@ ');
  if (hunkIndex >= 0) {
    return normalized.slice(hunkIndex);
  }

  return normalized;
}

function createEditDiff(filePath: string, oldText: string, newText: string): string {
  const hunks = createUnifiedDiffHunks(oldText, newText, { contextLines: 3 });
  return formatUnifiedDiffHunks(hunks);
}

function normalizeUnifiedDiff(filePath: string, unifiedDiff: string): string {
  const trimmed = unifiedDiff.trim();
  if (!trimmed) return '';
  return extractDiffHunkBody(trimmed);
}

function normalizeToolOperation(name: string): ChangeOperation | null {
  const normalized = name.trim().toLowerCase().split(/[:./]/).pop() || '';
  if (normalized === 'bash') return 'bash';
  if (normalized === 'exec_command') return 'bash';
  if (normalized === 'write') return 'write';
  if (
    normalized === 'edit' ||
    normalized === 'multiedit' ||
    normalized === 'notebookedit' ||
    normalized === 'apply_patch'
  ) return 'edit';
  if (normalized === 'delete') return 'delete';
  return null;
}

function statusToOperation(status: string): ChangeOperation {
  if (status === 'A') return 'added';
  if (status === 'D') return 'deleted';
  if (status === 'R') return 'renamed';
  if (status === '?') return 'untracked';
  return 'modified';
}

function buildToolResultMap(messages: StreamMessage[]): Map<string, ToolResultBlock> {
  const results = new Map<string, ToolResultBlock>();

  for (const message of messages) {
    for (const block of getMessageContentBlocks(message)) {
      const normalized = normalizeToolResultBlock(block);
      if (normalized) {
        results.set(normalized.tool_use_id, {
          type: 'tool_result',
          tool_use_id: normalized.tool_use_id,
          content: normalized.content,
          is_error: normalized.is_error,
        });
      }
    }
  }

  return results;
}

type PendingHeredoc = {
  delimiter: string;
  stripLeadingTabs: boolean;
};

function skipHeredocBodies(
  command: string,
  startIndex: number,
  pendingHeredocs: PendingHeredoc[]
): number {
  let cursor = startIndex;

  for (const heredoc of pendingHeredocs) {
    let foundDelimiter = false;

    while (cursor < command.length) {
      const newlineIndex = command.indexOf('\n', cursor);
      const lineEnd = newlineIndex >= 0 ? newlineIndex : command.length;
      const line = command.slice(cursor, lineEnd).replace(/\r$/, '');
      const comparableLine = heredoc.stripLeadingTabs ? line.replace(/^\t+/, '') : line;
      cursor = newlineIndex >= 0 ? newlineIndex + 1 : command.length;

      if (comparableLine === heredoc.delimiter) {
        foundDelimiter = true;
        break;
      }
    }

    if (!foundDelimiter) {
      return command.length;
    }
  }

  return cursor;
}

function tokenizeShell(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escapeNext = false;
  let awaitingHeredoc: Pick<PendingHeredoc, 'stripLeadingTabs'> | null = null;
  let pendingHeredocs: PendingHeredoc[] = [];

  const pushCurrent = () => {
    if (current.length > 0) {
      tokens.push(current);
      if (awaitingHeredoc) {
        pendingHeredocs.push({
          delimiter: current,
          stripLeadingTabs: awaitingHeredoc.stripLeadingTabs,
        });
        awaitingHeredoc = null;
      }
      current = '';
    }
  };

  const pushOperator = (operator: string) => {
    pushCurrent();
    tokens.push(operator);
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if (escapeNext) {
      current += char;
      escapeNext = false;
      continue;
    }

    if (char === '\\' && quote !== "'") {
      escapeNext = true;
      continue;
    }

    if ((char === '"' || char === "'")) {
      if (quote === char) {
        quote = null;
      } else if (quote === null) {
        quote = char;
      } else {
        current += char;
      }
      continue;
    }

    if (quote === null && char === '\n') {
      pushCurrent();
      if (tokens[tokens.length - 1] !== ';') {
        tokens.push(';');
      }
      if (pendingHeredocs.length > 0) {
        const resumeIndex = skipHeredocBodies(command, index + 1, pendingHeredocs);
        pendingHeredocs = [];
        index = resumeIndex - 1;
      }
      continue;
    }

    if (quote === null && /\s/.test(char)) {
      pushCurrent();
      continue;
    }

    if (quote === null && char === ';') {
      pushOperator(';');
      continue;
    }

    if (quote === null && (command.startsWith('&&', index) || command.startsWith('||', index))) {
      pushOperator(command.slice(index, index + 2));
      index += 1;
      continue;
    }

    if (quote === null && char === '|') {
      pushOperator('|');
      continue;
    }

    if (quote === null && command.startsWith('<<<', index)) {
      const descriptor = /^\d+$/.test(current) ? current : '';
      if (descriptor) {
        current = '';
      } else {
        pushCurrent();
      }
      tokens.push(`${descriptor}<<<`);
      index += 2;
      continue;
    }

    if (quote === null && command.startsWith('<<', index)) {
      const descriptor = /^\d+$/.test(current) ? current : '';
      if (descriptor) {
        current = '';
      } else {
        pushCurrent();
      }
      const stripLeadingTabs = command[index + 2] === '-';
      tokens.push(`${descriptor}<<${stripLeadingTabs ? '-' : ''}`);
      awaitingHeredoc = { stripLeadingTabs };
      index += stripLeadingTabs ? 2 : 1;
      continue;
    }

    if (quote === null && char === '&' && command[index + 1] === '>') {
      pushCurrent();
      const append = command[index + 2] === '>';
      tokens.push(`&>${append ? '>' : ''}`);
      index += append ? 2 : 1;
      continue;
    }

    if (quote === null && char === '>') {
      const descriptor = /^\d+$/.test(current) ? current : '';
      if (descriptor) {
        current = '';
      } else {
        pushCurrent();
      }
      const append = command[index + 1] === '>';
      tokens.push(`${descriptor}>${append ? '>' : ''}`);
      if (append) index += 1;
      continue;
    }

    current += char;
  }

  pushCurrent();
  return tokens;
}

function cleanCommandPath(token: string | undefined): string | null {
  if (!token) return null;
  const trimmed = token.trim().replace(/^["']+|["']+$/g, '').trim();
  if (!trimmed) return null;
  if (trimmed === '/dev/null') return null;
  if (/[\s<>{}()[\]`$*?]/.test(trimmed)) return null;
  if (!trimmed.includes('/') && !trimmed.includes('.')) return null;
  if (/^&\d+$/.test(trimmed)) return null;
  if (/^\d+>$/.test(trimmed)) return null;
  if (/^\d+>>$/.test(trimmed)) return null;
  if (trimmed.startsWith('-')) return null;
  return trimmed;
}

function isOutputRedirection(token: string): boolean {
  return /^(?:\d+|&)?>{1,2}$/.test(token);
}

function isInputRedirection(token: string): boolean {
  return /^(?:\d+)?(?:<<-?|<<<)$/.test(token);
}

function commandOperands(segment: string[], startIndex = 1): string[] {
  const operands: string[] = [];

  for (let index = startIndex; index < segment.length; index += 1) {
    const token = segment[index];
    if (isOutputRedirection(token) || isInputRedirection(token)) {
      index += 1;
      continue;
    }
    operands.push(token);
  }

  return operands;
}

function splitCommandSegments(tokens: string[]): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];

  for (const token of tokens) {
    if (token === '&&' || token === ';' || token === '||' || token === '|') {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
      continue;
    }
    current.push(token);
  }

  if (current.length > 0) {
    segments.push(current);
  }

  return segments;
}

function inferBashOperation(
  status: string,
  fallback: ChangeOperation
): ChangeOperation {
  if (status === 'D') return 'delete';
  if (status === 'R') return 'renamed';
  if (status === 'A' || status === '?') return 'write';
  return fallback;
}

function makeToolRecord(
  id: string,
  filePath: string,
  status: string,
  operation: ChangeOperation,
  state: ChangeRecordState,
  order: number,
  toolUseId: string,
  diffContent: string | null
): ChangeRecord {
  const { fileName, dirPath } = splitPath(filePath);
  const stats = diffContent ? countDiffStats(diffContent) : { addedLines: 0, removedLines: 0 };
  const contentSize =
    operation === 'write' && diffContent ? byteLength(diffContent) : null;

  return {
    id,
    filePath,
    fileName,
    dirPath,
    status,
    staged: false,
    source: 'tool',
    operation: inferBashOperation(status, operation),
    state,
    order,
    toolUseId,
    diffContent,
    sizeBytes: contentSize,
    lineCount: null,
    addedLines: stats.addedLines,
    removedLines: stats.removedLines,
  };
}

function parseBashChangeSpecs(command: string): Array<{
  filePath: string;
  status: string;
  operation: ChangeOperation;
}> {
  const specs: Array<{ filePath: string; status: string; operation: ChangeOperation }> = [];
  const seen = new Set<string>();
  const tokens = tokenizeShell(command);
  const segments = splitCommandSegments(tokens);

  const pushSpec = (filePath: string | null, status: string, operation: ChangeOperation) => {
    if (!filePath) return;
    const key = `${operation}:${status}:${filePath}`;
    if (seen.has(key)) return;
    seen.add(key);
    specs.push({ filePath, status, operation });
  };

  for (const segment of segments) {
    if (segment.length === 0) continue;

    if (segment[0] === 'cd') {
      continue;
    }

    if (segment[0] === 'rm') {
      for (const token of commandOperands(segment)) {
        pushSpec(cleanCommandPath(token), 'D', 'delete');
      }
      continue;
    }

    if (segment[0] === 'mv' && segment.length >= 3) {
      const operands = commandOperands(segment);
      pushSpec(cleanCommandPath(operands[operands.length - 1]), 'R', 'renamed');
      continue;
    }

    if (segment[0] === 'cp' && segment.length >= 3) {
      const operands = commandOperands(segment);
      pushSpec(cleanCommandPath(operands[operands.length - 1]), 'A', 'write');
      continue;
    }

    if (segment[0] === 'touch') {
      for (const token of commandOperands(segment)) {
        pushSpec(cleanCommandPath(token), 'A', 'write');
      }
      continue;
    }

    if (segment[0] === 'tee') {
      for (const token of commandOperands(segment)) {
        if (token.startsWith('-')) continue;
        pushSpec(cleanCommandPath(token), 'A', 'write');
      }
    }

    if (segment[0] === 'sed' && segment.includes('-i')) {
      const operands = commandOperands(segment);
      pushSpec(cleanCommandPath(operands[operands.length - 1]), 'M', 'edit');
      continue;
    }

    if (segment[0] === 'perl' && segment.some((token) => token.includes('-0pi') || token.includes('-pi'))) {
      const operands = commandOperands(segment);
      pushSpec(cleanCommandPath(operands[operands.length - 1]), 'M', 'edit');
      continue;
    }
  }

  for (const segment of segments) {
    for (let index = 0; index < segment.length; index += 1) {
      if (!isOutputRedirection(segment[index])) continue;
      pushSpec(cleanCommandPath(segment[index + 1]), 'A', 'write');
      index += 1;
    }
  }

  return specs;
}

function getToolFilePath(input: Record<string, unknown>): string | null {
  return getFirstString(input, [
    'file_path',
    'path',
    'file',
    'filename',
    'absolute_file_path',
    'absoluteFilePath',
    'notebook_path',
  ]);
}

function parseToolResultPayload(result: ToolResultBlock | undefined): Record<string, unknown> | null {
  if (!result || typeof result.content !== 'string') {
    return null;
  }

  try {
    const parsed = JSON.parse(result.content) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getToolResultMetadata(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  const metadata = payload?.metadata;
  return isRecord(metadata) ? metadata : null;
}

function extractPathFromTaggedOutput(output: string): string | null {
  const match = output.match(/<path>([^<\n]+)<\/path>/i);
  return match?.[1]?.trim() || null;
}

function extractPathFromDiff(diffContent: string): string | null {
  return extractUnifiedDiffFilePath(diffContent);
}

function getToolResultFilePath(result: ToolResultBlock | undefined): string | null {
  const payload = parseToolResultPayload(result);
  const metadata = getToolResultMetadata(payload);
  const metadataDiff = getString(metadata?.diff);
  if (metadataDiff) {
    const filePath = extractPathFromDiff(metadataDiff);
    if (filePath) {
      return filePath;
    }
  }

  const output = getString(payload?.output);
  if (output) {
    const filePath = extractPathFromTaggedOutput(output);
    if (filePath) {
      return filePath;
    }
  }

  return null;
}

function getToolResultDiffContent(
  result: ToolResultBlock | undefined,
  fallbackFilePath?: string | null
): string | null {
  const payload = parseToolResultPayload(result);
  const metadata = getToolResultMetadata(payload);
  const metadataDiff = getString(metadata?.diff);
  if (!metadataDiff) {
    return null;
  }

  const filePath = fallbackFilePath || extractPathFromDiff(metadataDiff);
  if (!filePath) {
    return metadataDiff.trim();
  }

  return normalizeUnifiedDiff(filePath, metadataDiff);
}

function buildRecordsFromStructuredChanges(
  input: Record<string, unknown>,
  blockId: string,
  state: ChangeRecordState,
  order: number
): ChangeRecord[] {
  const changes = isRecord(input.changes) ? input.changes : null;
  if (!changes) return [];

  const records: ChangeRecord[] = [];
  let offset = 0;

  for (const [originalPath, rawSpec] of Object.entries(changes)) {
    if (!isRecord(rawSpec)) continue;

    const nextPath =
      getString(rawSpec.move_path) ||
      getString(rawSpec.new_path) ||
      getString(rawSpec.path) ||
      originalPath;
    if (!nextPath) continue;

    const oldContent = getString(rawSpec.old_content);
    const newContent = getString(rawSpec.new_content) || getString(rawSpec.content);
    const unifiedDiff = getString(rawSpec.unified_diff);
    const type = getString(rawSpec.type)?.toLowerCase() || '';

    let status = 'M';
    let operation: ChangeOperation = 'edit';
    if (type === 'create' || type === 'add') {
      status = 'A';
      operation = 'write';
    } else if (type === 'delete' || type === 'remove') {
      status = 'D';
      operation = 'delete';
    } else if (type === 'update' || type === 'edit' || type === 'modify') {
      status = 'M';
      operation = 'edit';
    } else if (getString(rawSpec.move_path)) {
      status = 'R';
      operation = 'renamed';
    }

    let diffContent: string | null = null;
    if (unifiedDiff) {
      diffContent = normalizeUnifiedDiff(nextPath, unifiedDiff);
    } else if (oldContent !== null && newContent !== null) {
      diffContent =
        operation === 'write' ? createWriteDiff(nextPath, newContent) : createEditDiff(nextPath, oldContent, newContent);
    } else if (newContent !== null && operation === 'write') {
      diffContent = createWriteDiff(nextPath, newContent);
    }

    const { fileName, dirPath } = splitPath(nextPath);
    const stats = diffContent ? countDiffStats(diffContent) : { addedLines: 0, removedLines: 0 };

    records.push({
      id: `tool:${blockId}:${offset}`,
      filePath: nextPath,
      fileName,
      dirPath,
      status,
      staged: false,
      source: 'tool',
      operation,
      state,
      order: order + offset,
      toolUseId: blockId,
      diffContent,
      sizeBytes: newContent !== null ? byteLength(newContent) : null,
      lineCount: newContent !== null ? countLines(newContent) : null,
      addedLines: stats.addedLines,
      removedLines: stats.removedLines,
    });
    offset += 1;
  }

  return records;
}

function buildToolRecords(
  index: number,
  block: ToolUseBlock,
  result: ToolResultBlock | undefined
): ChangeRecord[] {
  const operation = normalizeToolOperation(block.name || '');
  if (!operation) return [];

  const input = isRecord(block.input) ? block.input : {};

  if (result?.is_error) {
    return [];
  }

  const state: ChangeRecordState = result ? 'success' : 'pending';

  const structuredChangeRecords = buildRecordsFromStructuredChanges(input, block.id, state, index);
  if (structuredChangeRecords.length > 0) {
    return structuredChangeRecords;
  }

  if (operation === 'bash') {
    const command = getFirstString(input, ['command', 'cmd', 'shellCommand', 'shell_command']);
    if (!command) return [];
    return parseBashChangeSpecs(command).map((spec, offset) =>
      makeToolRecord(
        `tool:${block.id}:${offset}`,
        spec.filePath,
        spec.status,
        spec.operation,
        state,
        index + offset,
        block.id,
        null
      )
    );
  }

  const filePath = getToolFilePath(input) || getToolResultFilePath(result);
  if (!filePath) return [];
  const { fileName, dirPath } = splitPath(filePath);

  if (operation === 'write') {
    const content = getFirstString(input, ['content', 'text', 'data', 'file_content']) || '';
    const diffContent = content ? createWriteDiff(filePath, content) : getToolResultDiffContent(result, filePath);
    const stats = diffContent ? countDiffStats(diffContent) : { addedLines: 0, removedLines: 0 };
    return [{
      id: `tool:${block.id}`,
      filePath,
      fileName,
      dirPath,
      status: 'A',
      staged: false,
      source: 'tool',
      operation,
      state,
      order: index,
      toolUseId: block.id,
      diffContent,
      sizeBytes: content ? byteLength(content) : null,
      lineCount: content ? countLines(content) : null,
      addedLines: content ? countLines(content) : stats.addedLines,
      removedLines: stats.removedLines,
    }];
  }

  if (operation === 'edit') {
    const oldText = getFirstString(input, [
      'old_string',
      'oldText',
      'old_text',
      'search',
      'before',
      'original',
      'old_source',
    ]);
    const newText = getFirstString(input, [
      'new_string',
      'newText',
      'new_text',
      'replace',
      'replacement',
      'after',
      'updated',
      'new_source',
    ]);
    const diffContent =
      oldText !== null && newText !== null
        ? createEditDiff(filePath, oldText, newText)
        : getToolResultDiffContent(result, filePath);
    const stats = diffContent ? countDiffStats(diffContent) : { addedLines: 0, removedLines: 0 };

    return [{
      id: `tool:${block.id}`,
      filePath,
      fileName,
      dirPath,
      status: 'M',
      staged: false,
      source: 'tool',
      operation,
      state,
      order: index,
      toolUseId: block.id,
      diffContent,
      sizeBytes: null,
      lineCount: null,
      addedLines: stats.addedLines,
      removedLines: stats.removedLines,
    }];
  }

  const diffContent = getToolResultDiffContent(result, filePath);
  const stats = diffContent ? countDiffStats(diffContent) : { addedLines: 0, removedLines: 0 };

  return [{
    id: `tool:${block.id}`,
    filePath,
    fileName,
    dirPath,
    status: 'D',
    staged: false,
    source: 'tool',
    operation,
    state,
    order: index,
    toolUseId: block.id,
    diffContent,
    sizeBytes: null,
    lineCount: null,
    addedLines: stats.addedLines,
    removedLines: stats.removedLines,
  }];
}

export function extractToolChangeRecords(messages: StreamMessage[]): ChangeRecord[] {
  const results = buildToolResultMap(messages);
  const records: ChangeRecord[] = [];
  let order = 0;

  for (const message of messages) {
    if (message.type !== 'assistant') continue;
    for (const block of getMessageContentBlocks(message)) {
      const normalized = normalizeToolUseBlock(block);
      if (!normalized) continue;
      const toolBlock: ToolUseBlock = {
        type: 'tool_use',
        id: normalized.id,
        name: normalized.name,
        input: normalized.input,
      };
      const nextRecords = buildToolRecords(order, toolBlock, results.get(toolBlock.id));
      if (nextRecords.length > 0) {
        records.push(...nextRecords);
        order += nextRecords.length;
      }
    }
  }

  return records;
}

function splitGitPatchByFile(patch: string): string[] {
  const normalized = patch.replace(/\r\n?/g, '\n');
  const starts = Array.from(normalized.matchAll(/^diff --git\s+/gm), (match) => match.index);
  if (starts.length === 0) return [];

  return starts.map((start, index) => {
    const end = starts[index + 1] ?? normalized.length;
    return normalized.slice(start, end).trim();
  });
}

function gitPatchStatus(filePatch: string): string {
  if (
    /^new file mode\s+/m.test(filePatch) ||
    /^---\s+["']?\/dev\/null["']?\s*$/m.test(filePatch)
  ) {
    return 'A';
  }
  if (
    /^deleted file mode\s+/m.test(filePatch) ||
    /^\+\+\+\s+["']?\/dev\/null["']?\s*$/m.test(filePatch)
  ) {
    return 'D';
  }
  if (/^rename (?:from|to)\s+/m.test(filePatch)) {
    return 'R';
  }
  return 'M';
}

/**
 * Convert the runner's completed-turn Git snapshot into the records shown by
 * the chat change card. Unlike tool inference, this is the authoritative list
 * of paths that actually differ between the start and end of the turn.
 */
export function extractGitPatchChangeRecords(patch: string): ChangeRecord[] {
  const records: ChangeRecord[] = [];

  for (const [index, filePatch] of splitGitPatchByFile(patch).entries()) {
    const filePath = extractUnifiedDiffFilePath(filePatch);
    if (!filePath || filePath === '/dev/null') continue;

    const status = gitPatchStatus(filePatch);
    const operation = statusToOperation(status);
    const { fileName, dirPath } = splitPath(filePath);
    const stats = countDiffStats(filePatch);

    records.push({
      id: `git-patch:${index}:${filePath}`,
      filePath,
      fileName,
      dirPath,
      status,
      staged: false,
      source: 'git',
      operation,
      state: 'success',
      order: index,
      diffContent: filePatch,
      sizeBytes: null,
      lineCount: null,
      addedLines: stats.addedLines,
      removedLines: stats.removedLines,
    });
  }

  return records;
}

export function mergeChangeRecords(
  toolRecords: ChangeRecord[],
  gitChanges: GitChangeEntry[]
): ChangeRecord[] {
  const seenPaths = new Set(toolRecords.map((record) => normalizePath(record.filePath)));
  const records = [...toolRecords];
  let order = toolRecords.length;

  for (const entry of gitChanges) {
    // Hide unrelated workspace-only untracked files. New files created by the
    // current session still appear through toolRecords above.
    if (entry.status === '?') {
      continue;
    }

    if (seenPaths.has(normalizePath(entry.filePath))) {
      continue;
    }

    const { fileName, dirPath } = splitPath(entry.filePath);
    records.push({
      id: `git:${entry.filePath}:${order}`,
      filePath: entry.filePath,
      fileName,
      dirPath,
      status: entry.status,
      staged: entry.staged,
      source: 'git',
      operation: statusToOperation(entry.status),
      state: 'success',
      order,
      diffContent: null,
      sizeBytes: null,
      lineCount: null,
      addedLines: 0,
      removedLines: 0,
    });
    order += 1;
  }

  return records;
}

export function applyDiffToChangeRecord(record: ChangeRecord, diffContent: string): ChangeRecord {
  if (!diffContent.trim()) {
    return record;
  }

  const stats = countDiffStats(diffContent);

  return {
    ...record,
    diffContent,
    addedLines: stats.addedLines,
    removedLines: stats.removedLines,
  };
}

export function applyTextMetaToChangeRecord(
  record: ChangeRecord,
  text: string,
  sizeBytes: number
): ChangeRecord {
  return {
    ...record,
    sizeBytes: record.sizeBytes ?? sizeBytes,
    lineCount: record.lineCount ?? countLines(text),
  };
}

export function summarizeChangeRecords(records: ChangeRecord[]): {
  total: number;
  totalSizeBytes: number;
  operationCounts: Array<{ operation: ChangeOperation; count: number }>;
} {
  const counts = new Map<ChangeOperation, number>();
  let totalSizeBytes = 0;

  for (const record of records) {
    counts.set(record.operation, (counts.get(record.operation) || 0) + 1);
    if (
      record.sizeBytes &&
      (record.operation === 'write' || record.operation === 'added' || record.operation === 'untracked')
    ) {
      totalSizeBytes += record.sizeBytes;
    }
  }

  const priority: ChangeOperation[] = [
    'bash',
    'write',
    'edit',
    'delete',
    'modified',
    'added',
    'deleted',
    'renamed',
    'untracked',
  ];

  const operationCounts = priority
    .map((operation) => ({ operation, count: counts.get(operation) || 0 }))
    .filter((entry) => entry.count > 0);

  return {
    total: records.length,
    totalSizeBytes,
    operationCounts,
  };
}

export function getOperationLabel(operation: ChangeOperation, count = 1): string {
  const singular =
    operation === 'bash' ? 'bash'
    : operation === 'write' ? 'write'
    : operation === 'edit' ? 'edit'
    : operation === 'delete' ? 'delete'
    : operation === 'modified' ? 'modified'
    : operation === 'added' ? 'added'
    : operation === 'deleted' ? 'deleted'
    : operation === 'renamed' ? 'renamed'
    : 'untracked';

  if (count === 1) {
    return singular;
  }

  if (operation === 'bash') return 'bash';
  if (operation === 'write') return 'writes';
  if (operation === 'edit') return 'edits';
  if (operation === 'delete') return 'deletes';
  return singular;
}

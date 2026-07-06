import type { ChangeOperation, ChangeRecord, ChangeRecordState } from './change-records';
import {
  getToolInputFilePath,
  getToolResultOutputContent,
  type WorkstreamEntry,
} from './workstream';

export type WorkstreamStageKind =
  | 'explore'
  | 'edit'
  | 'command'
  | 'approval'
  | 'error'
  | 'task'
  | 'memory'
  | 'web'
  | 'todo'
  | 'other';

export type WorkstreamStageStatus =
  | 'pending'
  | 'success'
  | 'error'
  | 'waiting'
  | 'interrupted'
  | 'mixed';

export interface WorkstreamStageFile {
  id: string;
  filePath: string;
  fileName: string;
  operation: ChangeOperation | 'read' | 'search';
  state: ChangeRecordState | 'success' | 'pending';
  addedLines: number;
  removedLines: number;
  record?: ChangeRecord;
  sourceToolUseId?: string;
}

export interface WorkstreamStageCommand {
  id: string;
  command: string;
  summary: string;
  status: WorkstreamStageStatus;
  output: string;
  outputSummary: string;
}

export interface WorkstreamStage {
  id: string;
  kind: WorkstreamStageKind;
  title: string;
  status: WorkstreamStageStatus;
  entries: WorkstreamEntry[];
  count: number;
  files: WorkstreamStageFile[];
  commands: WorkstreamStageCommand[];
  addedLines: number;
  removedLines: number;
  defaultExpanded: boolean;
}

export interface SummarizeWorkstreamEntriesOptions {
  changeRecordsByToolUseId?: Map<string, ChangeRecord[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function plural(count: number, singular: string, pluralValue = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralValue}`;
}

function basename(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

function getToolInputRecord(entry: WorkstreamEntry): Record<string, unknown> {
  if (!('block' in entry)) return {};
  return isRecord(entry.block.input) ? entry.block.input : {};
}

function getToolPath(input: Record<string, unknown>): string | null {
  return (
    getToolInputFilePath(input) ||
    getString(input.file) ||
    getString(input.absolute_file_path) ||
    getString(input.absoluteFilePath) ||
    getString(input.notebook_path)
  );
}

function getCommand(input: Record<string, unknown>): string | null {
  return (
    getString(input.command) ||
    getString(input.cmd) ||
    getString(input.shellCommand) ||
    getString(input.shell_command)
  );
}

function getPattern(input: Record<string, unknown>): string | null {
  return getString(input.pattern) || getString(input.query) || getString(input.glob);
}

function classifyStageKind(entry: WorkstreamEntry): WorkstreamStageKind | null {
  if (entry.type === 'error') return 'error';
  if (entry.type === 'approval') {
    return entry.state === 'denied' ? 'error' : 'approval';
  }
  if (entry.type === 'thinking' || entry.type === 'note') return null;

  // Task entries stay in the task stage even on failure — the subagent lane
  // renders the error state in place, keeping parallel runs visually grouped.
  if (entry.type === 'task' || entry.kind === 'subagent') return 'task';
  if (entry.status === 'error') return 'error';
  if (entry.type === 'memory' || entry.kind === 'memory') return 'memory';

  switch (entry.kind) {
    case 'file_read':
    case 'pattern_search':
      return 'explore';
    case 'file_change':
      return 'edit';
    case 'command_execution':
      return 'command';
    case 'web_search':
      return 'web';
    case 'approval':
      return 'approval';
    case 'todo_update':
      return 'todo';
    default:
      return 'other';
  }
}

function entryStatus(entry: WorkstreamEntry): WorkstreamStageStatus {
  if (entry.type === 'error') return 'error';
  if (entry.type === 'approval') {
    if (entry.state === 'waiting') return 'waiting';
    if (entry.state === 'denied') return 'error';
    return 'success';
  }
  if (entry.type === 'thinking') {
    return entry.state === 'active' ? 'pending' : 'success';
  }
  if (entry.type === 'note') {
    return entry.state === 'streaming' ? 'pending' : 'success';
  }
  if (entry.status === 'error') return 'error';
  if (entry.status === 'pending') return 'pending';
  if (entry.status === 'interrupted') return 'interrupted';
  return 'success';
}

function aggregateStatus(entries: WorkstreamEntry[]): WorkstreamStageStatus {
  const statuses = entries.map(entryStatus);
  if (statuses.includes('error')) return 'error';
  if (statuses.includes('waiting')) return 'waiting';
  if (statuses.includes('pending')) return 'pending';
  if (statuses.includes('interrupted')) return 'interrupted';
  return statuses.every((status) => status === 'success') ? 'success' : 'mixed';
}

function mergeRecordsByPath(records: ChangeRecord[]): ChangeRecord[] {
  const byPath = new Map<string, ChangeRecord>();

  for (const record of records) {
    const key = record.filePath.replaceAll('\\', '/');
    const existing = byPath.get(key);
    if (!existing) {
      byPath.set(key, { ...record });
      continue;
    }

    existing.addedLines += record.addedLines;
    existing.removedLines += record.removedLines;

    if (record.operation === 'delete') {
      existing.operation = 'delete';
    } else if (existing.operation !== 'write' && record.operation === 'write') {
      existing.operation = 'write';
    }

    if (record.diffContent) {
      existing.diffContent = existing.diffContent
        ? `${existing.diffContent}\n${record.diffContent}`
        : record.diffContent;
    }

    if (record.state === 'pending') {
      existing.state = 'pending';
    }
  }

  return Array.from(byPath.values());
}

function makeFileFromRecord(record: ChangeRecord): WorkstreamStageFile {
  return {
    id: record.id,
    filePath: record.filePath,
    fileName: record.fileName || basename(record.filePath),
    operation: record.operation,
    state: record.state,
    addedLines: record.addedLines,
    removedLines: record.removedLines,
    record,
    sourceToolUseId: record.toolUseId,
  };
}

function makeFallbackFile(
  entry: WorkstreamEntry,
  filePath: string,
  operation: WorkstreamStageFile['operation']
): WorkstreamStageFile {
  return {
    id: `${entry.id}:${operation}:${filePath}`,
    filePath,
    fileName: basename(filePath),
    operation,
    state: entryStatus(entry) === 'pending' ? 'pending' : 'success',
    addedLines: 0,
    removedLines: 0,
    sourceToolUseId: 'block' in entry ? entry.block.id : undefined,
  };
}

function getStageRecords(
  entries: WorkstreamEntry[],
  changeRecordsByToolUseId?: Map<string, ChangeRecord[]>
): ChangeRecord[] {
  if (!changeRecordsByToolUseId) return [];
  const records: ChangeRecord[] = [];
  for (const entry of entries) {
    if (!('block' in entry)) continue;
    const next = changeRecordsByToolUseId.get(entry.block.id);
    if (next?.length) {
      records.push(...next);
    }
  }
  return records;
}

function buildStageFiles(
  kind: WorkstreamStageKind,
  entries: WorkstreamEntry[],
  changeRecordsByToolUseId?: Map<string, ChangeRecord[]>
): WorkstreamStageFile[] {
  if (kind === 'edit') {
    const recordFiles = mergeRecordsByPath(getStageRecords(entries, changeRecordsByToolUseId)).map(makeFileFromRecord);
    if (recordFiles.length > 0) return recordFiles;

    const files: WorkstreamStageFile[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const input = getToolInputRecord(entry);
      const filePath = getToolPath(input);
      if (!filePath || seen.has(filePath)) continue;
      seen.add(filePath);
      const normalizedName = 'toolName' in entry ? entry.toolName.toLowerCase() : '';
      const operation =
        normalizedName.includes('delete') ? 'delete' : normalizedName.includes('write') ? 'write' : 'edit';
      files.push(makeFallbackFile(entry, filePath, operation));
    }
    return files;
  }

  if (kind !== 'explore') return [];

  const files: WorkstreamStageFile[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!('block' in entry)) continue;
    if (entry.kind !== 'file_read') continue;
    const input = getToolInputRecord(entry);
    const filePath = getToolPath(input);
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    files.push(makeFallbackFile(entry, filePath, 'read'));
  }
  return files;
}

function getCommandOutputSummary(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) return 'No output';
  const lines = trimmed.split('\n');
  const lastLine = lines[lines.length - 1]?.trim();
  if (lines.length === 1) return lastLine || trimmed;
  return `${lines.length} output lines · ${lastLine || 'see output'}`;
}

function getStageCommandOutput(entry: WorkstreamEntry): string {
  if (!('result' in entry)) return '';
  const rawContent = entry.result?.content;
  if (typeof rawContent === 'string') {
    try {
      const parsed = JSON.parse(rawContent) as unknown;
      if (isRecord(parsed) && typeof parsed.output === 'string') {
        return parsed.output;
      }
    } catch {
      // Fall through to the shared output formatter for non-JSON tool output.
    }
  }
  return getToolResultOutputContent(entry.result);
}

function buildStageCommands(entries: WorkstreamEntry[]): WorkstreamStageCommand[] {
  const commands: WorkstreamStageCommand[] = [];
  for (const entry of entries) {
    if (!('block' in entry)) continue;
    if (entry.kind !== 'command_execution') continue;
    const input = getToolInputRecord(entry);
    const command = getCommand(input) || entry.summary;
    const output = getStageCommandOutput(entry);
    commands.push({
      id: entry.block.id,
      command,
      summary: entry.summary,
      status: entryStatus(entry),
      output,
      outputSummary: getCommandOutputSummary(output),
    });
  }
  return commands;
}

function buildExploreTitle(entries: WorkstreamEntry[], files: WorkstreamStageFile[]): string {
  if (files.length > 0) {
    return `Explored ${plural(files.length, 'file')}`;
  }

  const patterns = new Set<string>();
  for (const entry of entries) {
    if (!('block' in entry)) continue;
    const pattern = getPattern(getToolInputRecord(entry));
    if (pattern) patterns.add(pattern);
  }

  if (patterns.size > 0) {
    return `Searched ${plural(patterns.size, 'pattern')}`;
  }

  return `Explored ${plural(entries.length, 'item')}`;
}

function buildEditTitle(files: WorkstreamStageFile[], entries: WorkstreamEntry[]): string {
  const targetCount = files.length || entries.length;
  const operations = new Set(files.map((file) => file.operation));
  let verb = 'Edited';
  if (operations.size === 1 && operations.has('write')) {
    verb = 'Created';
  } else if (operations.size === 1 && operations.has('delete')) {
    verb = 'Deleted';
  }
  return `${verb} ${plural(targetCount, files.length === 1 || files.length > 1 ? 'file' : 'item')}`;
}

function buildCommandTitle(commands: WorkstreamStageCommand[], entries: WorkstreamEntry[]): string {
  if (commands.length === 1) {
    return commands[0].summary || `Ran ${commands[0].command}`;
  }

  const failedCount = entries.filter((entry) => entryStatus(entry) === 'error').length;
  const base = `Ran ${plural(commands.length || entries.length, 'command')}`;
  return failedCount > 0 ? `${base} · ${failedCount} failed` : base;
}

function buildGenericTitle(
  kind: WorkstreamStageKind,
  entries: WorkstreamEntry[],
  status: WorkstreamStageStatus
): string {
  if (entries.length === 1) {
    return entries[0].summary;
  }

  switch (kind) {
    case 'approval':
      return status === 'waiting' ? 'Waiting for approval' : `Handled ${plural(entries.length, 'approval')}`;
    case 'error':
      return `${plural(entries.length, 'issue')} needs attention`;
    case 'task':
      return `Ran ${plural(entries.length, 'subagent task')}`;
    case 'memory':
      return `Used memory ${plural(entries.length, 'time')}`;
    case 'web':
      return `Searched the web ${plural(entries.length, 'time')}`;
    case 'todo':
      return `Updated todo list ${plural(entries.length, 'time')}`;
    default:
      return `${plural(entries.length, 'step')}`;
  }
}

function buildStageTitle(
  kind: WorkstreamStageKind,
  entries: WorkstreamEntry[],
  files: WorkstreamStageFile[],
  commands: WorkstreamStageCommand[],
  status: WorkstreamStageStatus
): string {
  if (kind === 'explore') return buildExploreTitle(entries, files);
  if (kind === 'edit') return buildEditTitle(files, entries);
  if (kind === 'command') return buildCommandTitle(commands, entries);
  return buildGenericTitle(kind, entries, status);
}

function makeStage(
  kind: WorkstreamStageKind,
  entries: WorkstreamEntry[],
  options: SummarizeWorkstreamEntriesOptions
): WorkstreamStage {
  const status = aggregateStatus(entries);
  const files = buildStageFiles(kind, entries, options.changeRecordsByToolUseId);
  const commands = buildStageCommands(entries);
  const addedLines = files.reduce((sum, file) => sum + file.addedLines, 0);
  const removedLines = files.reduce((sum, file) => sum + file.removedLines, 0);
  const firstEntry = entries[0];

  return {
    id: `stage:${kind}:${firstEntry.id}`,
    kind,
    title: buildStageTitle(kind, entries, files, commands, status),
    status,
    entries,
    count: entries.length,
    files,
    commands,
    addedLines,
    removedLines,
    defaultExpanded: status === 'error' || status === 'waiting',
  };
}

function getTaskParallelKey(entry: WorkstreamEntry): string | null {
  if (entry.type !== 'task') return null;
  return entry.sourceMessageUuid || null;
}

function shouldMergeStageEntries(
  currentKind: WorkstreamStageKind | null,
  nextKind: WorkstreamStageKind,
  lastEntry: WorkstreamEntry | null,
  nextEntry: WorkstreamEntry
): boolean {
  if (!currentKind || currentKind !== nextKind) return false;
  if (nextKind === 'approval' || nextKind === 'error' || nextKind === 'other') return false;
  if (nextKind === 'task') {
    // Only Tasks fanned out by the same assistant message actually ran in
    // parallel. Sequential Tasks (each launched after the previous resolved)
    // get their own stage so the board never mislabels them as a parallel run.
    const lastKey = lastEntry ? getTaskParallelKey(lastEntry) : null;
    const nextKey = getTaskParallelKey(nextEntry);
    return Boolean(lastKey && nextKey && lastKey === nextKey);
  }
  return true;
}

export function summarizeWorkstreamEntries(
  entries: WorkstreamEntry[],
  options: SummarizeWorkstreamEntriesOptions = {}
): WorkstreamStage[] {
  const stages: WorkstreamStage[] = [];
  let buffer: WorkstreamEntry[] = [];
  let bufferKind: WorkstreamStageKind | null = null;

  const flush = () => {
    if (!bufferKind || buffer.length === 0) return;
    stages.push(makeStage(bufferKind, buffer, options));
    buffer = [];
    bufferKind = null;
  };

  for (const entry of entries) {
    const nextKind = classifyStageKind(entry);
    if (!nextKind) continue;
    const lastEntry = buffer.length > 0 ? buffer[buffer.length - 1] : null;
    if (!shouldMergeStageEntries(bufferKind, nextKind, lastEntry, entry)) {
      flush();
      bufferKind = nextKind;
    }
    buffer.push(entry);
  }
  flush();

  return stages;
}

export function getStageChangeRecords(stage: WorkstreamStage): ChangeRecord[] {
  return stage.files.flatMap((file) => file.record ? [file.record] : []);
}

export function formatWorkstreamStageSummary(stages: WorkstreamStage[]): string {
  if (stages.length === 0) return 'No work details yet';

  const waiting = stages.find((stage) => stage.status === 'waiting');
  if (waiting) return waiting.title;

  const failedCount = stages.filter((stage) => stage.status === 'error').length;
  if (failedCount > 0) {
    return `${plural(failedCount, 'step')} needs attention`;
  }

  const parts: string[] = [];
  const editedFiles = new Set<string>();
  let commandCount = 0;
  let exploredFiles = new Set<string>();
  let exploreCount = 0;

  for (const stage of stages) {
    if (stage.kind === 'edit') {
      for (const file of stage.files) editedFiles.add(file.filePath);
    } else if (stage.kind === 'command') {
      commandCount += stage.commands.length || stage.entries.length;
    } else if (stage.kind === 'explore') {
      for (const file of stage.files) exploredFiles.add(file.filePath);
      if (stage.files.length === 0) exploreCount += stage.entries.length;
    }
  }

  if (editedFiles.size > 0) parts.push(`edited ${plural(editedFiles.size, 'file')}`);
  if (commandCount > 0) parts.push(`ran ${plural(commandCount, 'command')}`);
  if (exploredFiles.size > 0) {
    parts.push(`explored ${plural(exploredFiles.size, 'file')}`);
  } else if (exploreCount > 0) {
    parts.push(`explored ${plural(exploreCount, 'source')}`);
  }

  return parts.length > 0 ? parts.slice(0, 3).join(' · ') : `${plural(stages.length, 'stage')}`;
}

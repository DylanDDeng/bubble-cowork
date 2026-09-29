import type { ToolExecutionMetadata } from '../../shared/types';
import { extractComputerUseAppName, parseMcpToolName } from '../../shared/computer-use';
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
  | 'computer_use'
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
  execution?: ToolExecutionMetadata;
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
  /** macOS app shown beside Computer Use rows (Notes, Safari, …). */
  computerUseApp?: string | null;
  source?: string | null;
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

function classifyStageKind(entry: WorkstreamEntry, ignoreToolError = false): WorkstreamStageKind | null {
  if (entry.type === 'error') return 'error';
  if (entry.type === 'approval') {
    return entry.state === 'denied' && !ignoreToolError ? 'error' : 'approval';
  }
  if (entry.type === 'thinking' || entry.type === 'note' || entry.type === 'compaction') return null;

  // Task entries stay in the task stage even on failure — the subagent lane
  // renders the error state in place, keeping parallel runs visually grouped.
  if (entry.type === 'task' || entry.kind === 'subagent') return 'task';
  if (!ignoreToolError && entry.status === 'error') return 'error';
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
    case 'computer_use':
      return 'computer_use';
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
  if (entry.type === 'compaction') return entry.state === 'inProgress' ? 'pending' : entry.state === 'interrupted' ? 'interrupted' : 'success';
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
  if (statuses.includes('waiting')) return 'waiting';
  if (statuses.includes('pending')) return 'pending';
  if (statuses.includes('error')) return 'error';
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
  if ('liveOutput' in entry && entry.status === 'pending' && entry.liveOutput) return entry.liveOutput;
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
      execution: 'execution' in entry ? entry.execution : undefined,
    });
  }
  return commands;
}

function buildExploreTitle(entries: WorkstreamEntry[], files: WorkstreamStageFile[]): string {
  const active = entries.filter(entry => entryStatus(entry) === 'pending');
  const current = active.at(-1);
  if (current && 'toolName' in current) {
    const input = getToolInputRecord(current);
    if (current.kind === 'file_read') return `Reading ${basename(getToolPath(input) || 'files')}`;
    if (/glob|list/i.test(current.toolName)) return `Listing ${getToolPath(input) || 'files'}`;
    return `Searching ${getPattern(input) || 'files'}`;
  }
  const reads = new Set(files.filter(file => file.operation === 'read').map(file => file.filePath)).size;
  const lists = entries.filter(entry => 'toolName' in entry && /glob|list/i.test(entry.toolName)).length;
  const searches = entries.filter(entry => 'kind' in entry && entry.kind === 'pattern_search' && !('toolName' in entry && /glob|list/i.test(entry.toolName))).length;
  const parts = [reads ? plural(reads, 'file') : '', searches ? plural(searches, 'search', 'searches') : '', lists ? plural(lists, 'list') : ''].filter(Boolean);
  const stopped = entries.some(entry => entryStatus(entry) === 'interrupted');
  return `${stopped ? 'Stopped exploring' : 'Explored'} ${parts.length ? parts.join(', ') : plural(entries.length, 'item')}`;
}

function buildEditTitle(files: WorkstreamStageFile[], entries: WorkstreamEntry[]): string {
  const status = aggregateStatus(entries);
  const operations = new Set(files.map(file => file.operation));
  const operation = operations.size === 1 && operations.has('write') ? ['Creating', 'Created', 'creating']
    : operations.size === 1 && operations.has('delete') ? ['Deleting', 'Deleted', 'deleting']
    : ['Editing', 'Edited', 'editing'];
  const verb = status === 'pending' ? operation[0] : status === 'interrupted' ? `Stopped ${operation[2]}` : status === 'error' ? `Failed ${operation[2]}` : operation[1];
  return `${verb} ${files.length === 1 ? files[0].fileName : plural(files.length || entries.length, files.length ? 'file' : 'item')}`;
}

function buildCommandTitle(commands: WorkstreamStageCommand[], entries: WorkstreamEntry[]): string {
  const command = commands.find(command => command.status === 'pending') ?? commands[0];
  if (!command) return `${aggregateStatus(entries) === 'pending' ? 'Running' : 'Ran'} ${plural(entries.length, 'command')}`;
  const execution = command.execution;
  const verb = command.status === 'pending' ? execution?.background ? 'Running in background' : 'Running'
    : command.status === 'interrupted' ? 'Stopped'
    : execution?.status === 'declined' ? 'Denied'
    : command.status === 'error' ? 'Failed'
    : execution?.background ? 'Finished background command' : 'Ran';
  return `${verb} ${command.command}`;
}

/** Use supplied source identity; never infer an integration from output text. */
export function getWorkstreamToolSource(entry: WorkstreamEntry): string | null {
  if (!('toolName' in entry)) return null;
  const input = getToolInputRecord(entry);
  const source = getString(input.__aegisMcpServer) || parseMcpToolName(entry.toolName)?.server;
  if (!source) return null;
  const names: Record<string, string> = { github: 'GitHub', slack: 'Slack', notion: 'Notion', figma: 'Figma', 'google-drive': 'Google Drive', 'aegis-browser': 'Browser', browser: 'Browser' };
  return names[source] || source.replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function buildGenericTitle(
  kind: WorkstreamStageKind,
  entries: WorkstreamEntry[],
  status: WorkstreamStageStatus
): string {
  if (kind === 'other') {
    const source = getWorkstreamToolSource(entries[0]);
    const active = [...entries].reverse().find(entry => entryStatus(entry) === 'pending');
    if (active) return source ? `Using ${source}: ${active.summary}` : active.summary;
    if (source) return entries.length > 1 ? `Used ${source} · ${plural(entries.length, 'call')}` : `${source}: ${entries[0].summary}`;
  }
  if (entries.length === 1) return entries[0].summary;

  switch (kind) {
    case 'approval':
      return status === 'waiting' ? 'Waiting for approval' : `Handled ${plural(entries.length, 'approval')}`;
    case 'error':
      return `${plural(entries.length, 'issue')} needs attention`;
    case 'task':
      return `${entries.some(entry => entryStatus(entry) === 'pending') ? 'Running' : 'Ran'} ${plural(entries.length, 'subagent task')}`;
    case 'memory':
      return `Used memory ${plural(entries.length, 'time')}`;
    case 'web':
      return status === 'pending' ? 'Searching the web' : `Searched the web ${plural(entries.length, 'time')}`;
    case 'todo':
      return `Updated todo list ${plural(entries.length, 'time')}`;
    case 'computer_use': {
      const summaries = entries
        .map((entry) => ('summary' in entry ? entry.summary : ''))
        .filter((summary): summary is string => Boolean(summary && summary.trim()));
      if (summaries.length === 1) return summaries[0];
      return status === 'pending'
        ? 'Using the computer'
        : `Used the computer ${plural(entries.length, 'time')}`;
    }
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
  const status = kind === 'task' && entries.some(entry => entryStatus(entry) === 'error')
    ? 'error' : aggregateStatus(entries);
  const files = buildStageFiles(kind, entries, options.changeRecordsByToolUseId);
  const commands = buildStageCommands(entries);
  const addedLines = files.reduce((sum, file) => sum + file.addedLines, 0);
  const removedLines = files.reduce((sum, file) => sum + file.removedLines, 0);
  const firstEntry = entries[0];

  return {
    id: `stage:${kind}:${firstEntry.id}`,
    kind,
    title: buildStageTitle(kind === 'error' ? classifyStageKind(firstEntry, true) || kind : kind, entries, files, commands, status),
    status,
    entries,
    count: entries.length,
    files,
    commands,
    addedLines,
    removedLines,
    defaultExpanded: status === 'waiting',
    source: getWorkstreamToolSource(firstEntry),
    computerUseApp: kind === 'computer_use' ? extractComputerUseAppName(getToolInputRecord(firstEntry)) : null,
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
  if (nextKind === 'approval' || nextKind === 'error' || nextKind === 'command') return false;
  if (nextKind === 'other') return Boolean(lastEntry && 'toolName' in lastEntry && 'toolName' in nextEntry
    && getWorkstreamToolSource(lastEntry) && lastEntry.toolName === nextEntry.toolName
    && JSON.stringify(lastEntry.block.input) === JSON.stringify(nextEntry.block.input));
  if (nextKind === 'computer_use') return false;
  // Each edit owns its own diff, including consecutive edits of the same file.
  if (nextKind === 'edit') return false;
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

export function getWorkstreamFailureCount(entries: WorkstreamEntry[]): number {
  return entries.filter(entry => entryStatus(entry) === 'error' && getWorkstreamDeniedActionIds(entry).length === 0).length;
}

export function getWorkstreamStageActivityKind(stage: WorkstreamStage): WorkstreamStageKind {
  return stage.kind === 'error' ? classifyStageKind(stage.entries[0], true) || 'error' : stage.kind;
}

export function formatWorkstreamStageSummary(stages: WorkstreamStage[]): string {
  if (stages.length === 0) return 'No work details yet';

  const waiting = stages.find((stage) => stage.status === 'waiting');
  if (waiting) return waiting.title;

  // Failed tools retain their activity description in the collapsed group.
  stages = stages.map(stage => ({ ...stage, kind: getWorkstreamStageActivityKind(stage) }));
  const parts: string[] = [];
  const kinds = new Set(stages.map(stage => stage.kind));
  for (const kind of kinds) {
    const matching = stages.filter(stage => stage.kind === kind);
    if (kind === 'edit') {
      const files = new Set(matching.flatMap(stage => stage.files.map(file => file.filePath)));
      parts.push(files.size ? `edited ${plural(files.size, 'file')}` : 'edited files');
    } else if (kind === 'command') {
      const count = matching.reduce((total, stage) => total + (stage.commands.length || stage.entries.length), 0);
      parts.push(`ran ${plural(count, 'command')}`);
    } else if (kind === 'explore') parts.push(buildExploreTitle(matching.flatMap(stage => stage.entries), matching.flatMap(stage => stage.files)).toLowerCase());
    else if (kind === 'web') parts.push('searched the web');
    else if (kind === 'computer_use') parts.push('used the computer');
    else if (kind === 'approval') {
      const count = new Set(matching.flatMap(stage => stage.entries.flatMap(getWorkstreamDeniedActionIds))).size;
      if (count) parts.push(`had ${plural(count, 'denied action')}`);
    }
    else if (kind === 'memory') parts.push('used memory');
    else if (kind === 'task') parts.push('worked with agents');
    else if (kind === 'other') {
      const sources = [...new Set(matching.map(stage => stage.source).filter((source): source is string => Boolean(source)))];
      if (sources.length) parts.push(`used ${new Intl.ListFormat('en').format(sources)}`);
      const unnamed = matching.filter(stage => !stage.source).reduce((total, stage) => total + stage.entries.length, 0);
      if (unnamed) parts.push(`called ${plural(unnamed, 'tool')}`);
    }
    else if (kind === 'error') parts.push(matching.length === 1 ? 'encountered an error' : 'encountered errors');
  }
  const summary = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(parts);
  return summary ? summary[0].toUpperCase() + summary.slice(1) : 'Completed work';
}

/** Failed executions and denied approvals are different events. Keep historical denials after retry. */
export function getWorkstreamDeniedActionIds(entry: WorkstreamEntry): string[] {
  if (entry.type === 'approval') return entry.state === 'denied' ? [entry.id] : [];
  if (!('execution' in entry)) return [];
  const reviews = entry.execution?.approvalReviews?.map(review => review.id) ?? [];
  return reviews.length ? reviews : entry.execution?.status === 'declined' ? [entry.id] : [];
}

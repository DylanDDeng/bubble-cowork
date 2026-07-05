import { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  ChevronRight,
  CircleX,
  FileDiff,
  FolderSearch,
  LoaderCircle,
  ShieldAlert,
  SquareTerminal,
} from './icons';
import {
  type ToolResultBlock,
  type ToolUseBlock,
  type WorkstreamEntry,
  type WorkstreamModel,
  getToolInputContent,
  getToolInputFilePath,
  getToolInputNewText,
  getToolInputOldText,
  getToolResultDiffContent,
  getToolResultOutputContent,
  safeJsonStringify,
} from '../utils/workstream';
import {
  createUnifiedDiffHunks,
  extractUnifiedDiffFilePath,
  parseUnifiedDiff,
  type UnifiedDiffHunk,
  type UnifiedDiffLine,
} from '../utils/unified-diff';
import { TodoProgressCard } from './TodoProgressCard';
import { DiffStatLabel } from './DiffStatLabel';
import { useTurnDiffContext } from './TurnDiffContext';
import { StructuredResponse } from './StructuredResponse';
import type { ChangeRecord } from '../utils/change-records';
import {
  getStageChangeRecords,
  summarizeWorkstreamEntries,
  type WorkstreamStage,
  type WorkstreamStageCommand,
  type WorkstreamStageFile,
} from '../utils/workstream-stages';
import { FileTypeIcon } from './FileTypeIcon';

interface AssistantWorkstreamProps {
  model: WorkstreamModel;
  className?: string;
}

const VISIBLE_COMPACT_ENTRIES = 8;
const MAX_TRACE_TEXT_CHARS = 20_000;
const MAX_TITLE_CHARS = 800;
const MAX_TOOL_OUTPUT_CHARS = 120_000;

export function AssistantWorkstream({ model, className = '' }: AssistantWorkstreamProps) {
  const [overflowOpen, setOverflowOpen] = useState(false);
  // Hooks must run in the same order every render — keep useMemo above any
  // conditional early return.
  const groups = useMemo(() => groupEntries(model.entries), [model.entries]);

  if (model.entries.length === 0 && !model.todoProgress) {
    return null;
  }

  return (
    <div className={`my-2 ${className}`.trim()}>
      {groups.map((group, idx) => {
        if (group.kind === 'text') {
          return <TextSegment key={`g${idx}`} entry={group.entry} />;
        }
        return (
          <CompactGroup
            key={`g${idx}`}
            entries={group.entries}
            overflowOpen={overflowOpen}
            onToggleOverflow={() => setOverflowOpen((v) => !v)}
          />
        );
      })}
      {model.todoProgress ? (
        <div className="my-2">
          <TodoProgressCard state={model.todoProgress} />
        </div>
      ) : null}
    </div>
  );
}

// ── Grouping ────────────────────────────────────────────────────────────────

type EntryGroup =
  | { kind: 'text'; entry: Extract<WorkstreamEntry, { type: 'note' }> }
  | { kind: 'compact'; entries: WorkstreamEntry[] };

function groupEntries(entries: WorkstreamEntry[]): EntryGroup[] {
  const groups: EntryGroup[] = [];
  let buffer: WorkstreamEntry[] = [];

  const flush = () => {
    if (buffer.length > 0) {
      groups.push({ kind: 'compact', entries: buffer });
      buffer = [];
    }
  };

  for (const entry of entries) {
    if (entry.type === 'note') {
      flush();
      groups.push({ kind: 'text', entry });
    } else {
      buffer.push(entry);
    }
  }
  flush();
  return groups;
}

// ── Text segment (assistant narration during the trace) ─────────────────────

function TextSegment({
  entry,
}: {
  entry: Extract<WorkstreamEntry, { type: 'note' }>;
}) {
  const text = entry.detail || entry.summary;
  if (!text.trim()) return null;
  const displayText = truncateWithNotice(text, MAX_TRACE_TEXT_CHARS);
  return (
    <div className="my-2 min-w-0 overflow-x-auto">
      <StructuredResponse content={displayText} streaming={entry.state === 'streaming'} />
    </div>
  );
}

// ── Compact group with overflow ─────────────────────────────────────────────

function CompactGroup({
  entries,
  overflowOpen,
  onToggleOverflow,
}: {
  entries: WorkstreamEntry[];
  overflowOpen: boolean;
  onToggleOverflow: () => void;
}) {
  const { changeRecordsByToolUseId, onOpenDiff } = useTurnDiffContext();
  const stages = useMemo(
    () => summarizeWorkstreamEntries(entries, { changeRecordsByToolUseId }),
    [changeRecordsByToolUseId, entries]
  );
  const showOverflow = stages.length > VISIBLE_COMPACT_ENTRIES;
  const visibleStages =
    showOverflow && !overflowOpen ? stages.slice(0, VISIBLE_COMPACT_ENTRIES) : stages;
  const hiddenCount = stages.length - VISIBLE_COMPACT_ENTRIES;

  return (
    <div className="my-2 space-y-px">
      {visibleStages.map((stage) => (
        <StageRow key={stage.id} stage={stage} onOpenDiff={onOpenDiff} />
      ))}
      {showOverflow ? (
        <button
          type="button"
          onClick={onToggleOverflow}
          className="flex w-full items-center justify-start py-0.5 text-[12px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
        >
          {overflowOpen
            ? 'Hide additional stages'
            : `+${hiddenCount} more stage${hiddenCount > 1 ? 's' : ''}`}
        </button>
      ) : null}
    </div>
  );
}

// ── Stage summary rows ─────────────────────────────────────────────────────

function StageRow({
  stage,
  onOpenDiff,
}: {
  stage: WorkstreamStage;
  onOpenDiff?: (
    record: ChangeRecord,
    scope?: { records: ChangeRecord[]; label?: string; turnKey?: string }
  ) => void;
}) {
  const [expanded, setExpanded] = useState(() => stage.defaultExpanded);

  useEffect(() => {
    if (stage.defaultExpanded) {
      setExpanded(true);
    }
  }, [stage.defaultExpanded]);

  const hasErrorFallback = stage.status === 'error' && stage.entries.some(hasRawEntryDetail);
  const canExpand = stage.files.length > 0 || stage.commands.length > 0 || hasErrorFallback;
  const isPending = stage.status === 'pending';
  const isError = stage.status === 'error';
  const titleClass = isError
    ? 'text-[var(--error)]'
    : isPending || stage.status === 'waiting'
      ? 'text-[var(--text-secondary)]'
      : 'text-[var(--text-muted)]/70 group-hover:text-[var(--text-secondary)]';

  return (
    <div className="group/stage">
      <button
        type="button"
        onClick={() => canExpand && setExpanded((value) => !value)}
        disabled={!canExpand}
        className={`flex w-full items-center gap-1.5 py-0.5 text-left text-[12px] leading-5 transition-colors disabled:opacity-100 ${
          canExpand ? '' : 'cursor-default'
        }`}
        aria-expanded={canExpand ? expanded : undefined}
      >
        <StageKindIcon stage={stage} />
        <span className={`min-w-0 flex-1 truncate ${titleClass}`}>{stage.title}</span>
        {stage.kind === 'edit' ? (
          <DiffStatLabel additions={stage.addedLines} deletions={stage.removedLines} muted />
        ) : null}
        <StageStatusGlyph stage={stage} expanded={expanded} canExpand={canExpand} />
      </button>
      {expanded && canExpand ? (
        <StageDetails stage={stage} onOpenDiff={onOpenDiff} />
      ) : null}
    </div>
  );
}

function StageKindIcon({ stage }: { stage: WorkstreamStage }) {
  const className = `h-3.5 w-3.5 flex-shrink-0 ${
    stage.status === 'error'
      ? 'text-[var(--error)]'
      : stage.status === 'waiting'
        ? 'text-amber-600'
        : 'text-[var(--text-muted)]/55'
  }`;

  if (stage.kind === 'edit') return <FileDiff className={className} />;
  if (stage.kind === 'command') return <SquareTerminal className={className} />;
  if (stage.kind === 'approval') return <ShieldAlert className={className} />;
  if (stage.kind === 'error') return <CircleX className={className} />;
  return <FolderSearch className={className} />;
}

function StageStatusGlyph({
  stage,
  expanded,
  canExpand,
}: {
  stage: WorkstreamStage;
  expanded: boolean;
  canExpand: boolean;
}) {
  if (stage.status === 'pending') {
    return <LoaderCircle className="h-3 w-3 flex-shrink-0 animate-spin text-[var(--text-muted)]/60" />;
  }
  if (stage.status === 'error') {
    return <CircleX className="h-3 w-3 flex-shrink-0 text-[var(--error)]" />;
  }
  if (stage.status === 'waiting') {
    return <ShieldAlert className="h-3 w-3 flex-shrink-0 text-amber-600" />;
  }
  if (!canExpand) {
    return stage.status === 'success' ? (
      <CheckCircle2 className="h-3 w-3 flex-shrink-0 text-[var(--text-muted)]/35" />
    ) : null;
  }
  return (
    <ChevronRight
      className={`h-3 w-3 flex-shrink-0 text-[var(--text-muted)]/45 transition-transform ${
        expanded ? 'rotate-90' : ''
      }`}
    />
  );
}

function StageDetails({
  stage,
  onOpenDiff,
}: {
  stage: WorkstreamStage;
  onOpenDiff?: (
    record: ChangeRecord,
    scope?: { records: ChangeRecord[]; label?: string; turnKey?: string }
  ) => void;
}) {
  const showErrorFallback =
    stage.status === 'error' && stage.files.length === 0 && stage.commands.length === 0;

  return (
    <div className="mb-1 ml-1 space-y-2 border-l border-[var(--border)]/50 pl-3">
      {stage.files.length > 0 ? (
        <StageFilesDetail stage={stage} onOpenDiff={onOpenDiff} />
      ) : null}
      {stage.commands.length > 0 ? <StageCommandsDetail commands={stage.commands} /> : null}
      {showErrorFallback ? (
        <StageErrorFallback entries={stage.entries} />
      ) : stage.status === 'error' ? (
        <StageFailureNotes entries={stage.entries} />
      ) : null}
    </div>
  );
}

// Command failures already show their output in StageCommandsDetail, so the
// failure notes only cover the remaining failed entries (e.g. a rejected Edit).
function StageFailureNotes({ entries }: { entries: WorkstreamEntry[] }) {
  const failed = entries.filter(isFailedNonCommandEntry);
  if (failed.length === 0) return null;

  return (
    <div className="space-y-1">
      {failed.map((entry) => (
        <FailureNote key={entry.id} entry={entry} />
      ))}
    </div>
  );
}

function isFailedNonCommandEntry(entry: WorkstreamEntry): boolean {
  if ('kind' in entry && entry.kind === 'command_execution') return false;
  if (entry.type === 'error') return true;
  if (entry.type === 'approval') return entry.state === 'denied';
  if (entry.type === 'tool' || entry.type === 'task' || entry.type === 'memory') {
    return entry.status === 'error';
  }
  return false;
}

function getEntryFailureText(entry: WorkstreamEntry): string {
  if (entry.type === 'tool' || entry.type === 'task' || entry.type === 'memory') {
    const output = getToolResultOutputContent(entry.result).trim();
    if (output) return output;
  }
  return (entry.detail || '').trim();
}

function FailureNote({ entry }: { entry: WorkstreamEntry }) {
  const text = getEntryFailureText(entry);
  return (
    <div className="overflow-hidden rounded-sm border border-[var(--border)]/45 bg-[var(--bg-secondary)]/30">
      <div
        className={`flex items-center gap-1.5 px-2 py-1 text-[11px] text-[var(--error)] ${
          text ? 'border-b border-[var(--border)]/45' : ''
        }`}
      >
        <CircleX className="h-3 w-3 flex-shrink-0" />
        <span className="min-w-0 flex-1 truncate">{entry.summary}</span>
      </div>
      {text ? <TailClampedOutput text={text} toneClass="text-[var(--error)]" /> : null}
    </div>
  );
}

function StageErrorFallback({
  entries,
}: {
  entries: WorkstreamEntry[];
}) {
  const visibleEntries = entries.filter(hasRawEntryDetail);
  if (visibleEntries.length === 0) return null;

  return (
    <div className="space-y-px">
      {visibleEntries.map((entry) => (
        <EntryRow key={entry.id} entry={entry} showChangeHint={false} />
      ))}
    </div>
  );
}

function StageFilesDetail({
  stage,
  onOpenDiff,
}: {
  stage: WorkstreamStage;
  onOpenDiff?: (
    record: ChangeRecord,
    scope?: { records: ChangeRecord[]; label?: string; turnKey?: string }
  ) => void;
}) {
  const records = getStageChangeRecords(stage);
  return (
    <div className="space-y-px">
      {stage.files.map((file) => (
        <StageFileRow
          key={file.id}
          file={file}
          records={records}
          onOpenDiff={onOpenDiff}
        />
      ))}
    </div>
  );
}

function StageFileRow({
  file,
  records,
  onOpenDiff,
}: {
  file: WorkstreamStageFile;
  records: ChangeRecord[];
  onOpenDiff?: (
    record: ChangeRecord,
    scope?: { records: ChangeRecord[]; label?: string; turnKey?: string }
  ) => void;
}) {
  const clickable = Boolean(file.record && onOpenDiff);
  const operationLabel = formatFileOperation(file.operation);
  const body = (
    <>
      <FileTypeIcon name={file.fileName} className="h-3.5 w-3.5 flex-shrink-0 opacity-75" />
      <span className="w-12 flex-shrink-0 text-[var(--text-muted)]/60">{operationLabel}</span>
      <span
        className={`min-w-0 flex-1 truncate font-mono ${
          clickable ? 'text-[var(--accent)] group-hover/file:underline' : 'text-[var(--text-secondary)]'
        }`}
      >
        {file.filePath}
      </span>
      <DiffStatLabel additions={file.addedLines} deletions={file.removedLines} />
    </>
  );

  if (clickable && file.record) {
    return (
      <button
        type="button"
        onClick={() =>
          onOpenDiff?.(file.record!, {
            records,
            label: stageFileScopeLabel(records.length),
          })
        }
        title={file.filePath}
        className="group/file flex w-full items-center gap-1.5 rounded-sm px-1 py-0.5 text-left text-[11px] leading-5 transition-colors hover:bg-[var(--bg-tertiary)]/30"
      >
        {body}
      </button>
    );
  }

  return (
    <div
      title={file.filePath}
      className="flex w-full items-center gap-1.5 rounded-sm px-1 py-0.5 text-[11px] leading-5"
    >
      {body}
    </div>
  );
}

function StageCommandsDetail({ commands }: { commands: WorkstreamStageCommand[] }) {
  return (
    <div className="space-y-1">
      {commands.map((command) => (
        <div
          key={command.id}
          className="overflow-hidden rounded-sm border border-[var(--border)]/45 bg-[var(--bg-secondary)]/30"
        >
          <div className="flex items-center gap-2 border-b border-[var(--border)]/45 px-2 py-1">
            <span className="text-[11px] font-medium text-[var(--text-muted)]">Shell</span>
            <span className="ml-auto text-[11px] text-[var(--text-muted)]/70">
              {formatCommandStatus(command.status)}
            </span>
          </div>
          <pre className="whitespace-pre-wrap break-words px-2 py-1 font-mono text-[11px] leading-5 text-[var(--text-secondary)]">
            $ {command.command}
          </pre>
          <CommandOutputPreview command={command} />
        </div>
      ))}
    </div>
  );
}

const OUTPUT_PREVIEW_LINES = 8;

function TailClampedOutput({ text, toneClass }: { text: string; toneClass: string }) {
  const [showFull, setShowFull] = useState(false);
  const lines = text.split('\n');
  const hiddenLines = lines.length - OUTPUT_PREVIEW_LINES;
  const displayText =
    showFull || hiddenLines <= 0
      ? truncateWithNotice(text, MAX_TRACE_TEXT_CHARS)
      : lines.slice(-OUTPUT_PREVIEW_LINES).join('\n');

  return (
    <>
      {hiddenLines > 0 ? (
        <button
          type="button"
          onClick={() => setShowFull((value) => !value)}
          className="flex w-full items-center px-2 py-0.5 text-left text-[11px] text-[var(--text-muted)]/70 transition-colors hover:text-[var(--text-secondary)]"
        >
          {showFull ? 'Show fewer lines' : `Show ${hiddenLines} earlier lines`}
        </button>
      ) : null}
      <pre
        className={`whitespace-pre-wrap break-words px-2 py-1 font-mono text-[11px] leading-5 ${toneClass}`}
      >
        {displayText}
      </pre>
    </>
  );
}

function CommandOutputPreview({ command }: { command: WorkstreamStageCommand }) {
  const trimmed = command.output.trim();
  const toneClass =
    command.status === 'error' ? 'text-[var(--error)]' : 'text-[var(--text-muted)]';

  if (!trimmed) {
    return (
      <pre
        className={`whitespace-pre-wrap break-words border-t border-[var(--border)]/35 px-2 py-1 font-mono text-[11px] leading-5 ${toneClass}`}
      >
        {command.outputSummary}
      </pre>
    );
  }

  return (
    <div className="border-t border-[var(--border)]/35">
      <TailClampedOutput text={trimmed} toneClass={toneClass} />
    </div>
  );
}

function formatFileOperation(operation: WorkstreamStageFile['operation']): string {
  if (operation === 'write' || operation === 'added') return 'Created';
  if (operation === 'delete' || operation === 'deleted') return 'Deleted';
  if (operation === 'renamed') return 'Moved';
  if (operation === 'read') return 'Read';
  if (operation === 'search') return 'Searched';
  return 'Edited';
}

function stageFileScopeLabel(count: number): string {
  return count === 1 ? 'Selected file changes' : `${count} files changed in this stage`;
}

function formatCommandStatus(status: WorkstreamStageCommand['status']): string {
  if (status === 'pending') return 'Running';
  if (status === 'error') return 'Error';
  if (status === 'waiting') return 'Waiting';
  return 'Success';
}

function hasRawEntryDetail(entry: WorkstreamEntry): boolean {
  if (entry.type === 'tool' || entry.type === 'task' || entry.type === 'memory') {
    return hasEntryDetail(entry);
  }
  return Boolean(entry.detail);
}

// ── Entry row dispatcher ────────────────────────────────────────────────────

function EntryRow({ entry, showChangeHint = true }: { entry: WorkstreamEntry; showChangeHint?: boolean }) {
  if (entry.type === 'thinking') {
    return <ThinkingRow entry={entry} />;
  }
  if (entry.type === 'note') {
    return <StreamingNoteRow entry={entry} />;
  }
  if (entry.type === 'approval') {
    return <ApprovalRow entry={entry} />;
  }
  if (entry.type === 'error') {
    return <ErrorRow entry={entry} />;
  }
  return <ToolRow entry={entry} showChangeHint={showChangeHint} />;
}

function StreamingNoteRow({
  entry,
}: {
  entry: Extract<WorkstreamEntry, { type: 'note' }>;
}) {
  return (
    <div
      className="flex items-baseline gap-1.5 py-0.5 text-[12px] leading-5 text-[var(--text-muted)]/55"
      title={safeTitle(entry.detail)}
    >
      <span className="min-w-0 flex-1 truncate">{entry.summary}</span>
      <span className="inline-flex h-1 w-1 flex-shrink-0 rounded-full bg-[var(--text-muted)]/45 animate-pulse" />
    </div>
  );
}

// ── Thinking row ────────────────────────────────────────────────────────────

function ThinkingRow({
  entry,
}: {
  entry: Extract<WorkstreamEntry, { type: 'thinking' }>;
}) {
  const isActive = entry.state === 'active';
  return (
    <div
      className="flex items-baseline gap-1.5 py-0.5 text-[12px] leading-5 text-[var(--text-muted)]/55"
      title={safeTitle(entry.detail)}
    >
      <span className="min-w-0 flex-1 truncate">{entry.summary}</span>
      {isActive ? (
        <span className="inline-flex h-1 w-1 flex-shrink-0 rounded-full bg-[var(--text-muted)]/45 animate-pulse" />
      ) : null}
    </div>
  );
}

// ── Approval row ────────────────────────────────────────────────────────────

function ApprovalRow({
  entry,
}: {
  entry: Extract<WorkstreamEntry, { type: 'approval' }>;
}) {
  const tone =
    entry.state === 'approved'
      ? 'text-emerald-600'
      : entry.state === 'denied'
        ? 'text-[var(--error)]'
        : 'text-amber-600';

  return (
    <div className="flex items-center gap-2 py-0.5 text-[12px] leading-5 text-[var(--text-primary)]">
      <ShieldAlert className={`h-3.5 w-3.5 flex-shrink-0 ${tone}`} />
      <span className="min-w-0 flex-1 truncate">{entry.summary}</span>
      <span className={`flex-shrink-0 text-[11px] uppercase tracking-[0.06em] ${tone}`}>
        {entry.state}
      </span>
    </div>
  );
}

// ── Error row ───────────────────────────────────────────────────────────────

function ErrorRow({
  entry,
}: {
  entry: Extract<WorkstreamEntry, { type: 'error' }>;
}) {
  return (
    <div className="flex items-baseline gap-2 py-0.5 text-[12px] leading-5 text-[var(--error)]" title={safeTitle(entry.detail)}>
      <CircleX className="h-3.5 w-3.5 flex-shrink-0" />
      <span className="min-w-0 flex-1 truncate">{entry.summary}</span>
    </div>
  );
}

// ── Tool/task/memory row (the compact dpcode-style line) ────────────────────

function ToolRow({
  entry,
  showChangeHint = true,
}: {
  entry: Extract<WorkstreamEntry, { type: 'tool' | 'task' | 'memory' }>;
  showChangeHint?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const { changeRecordByToolUseId, onOpenDiff } = useTurnDiffContext();
  const changeRecord = changeRecordByToolUseId.get(entry.block.id) || null;

  const canExpand = hasEntryDetail(entry);
  const isPending = entry.status === 'pending';
  const isError = entry.status === 'error';

  const summaryClass = isError
    ? 'text-[var(--error)]'
    : isPending
      ? 'text-[var(--text-muted)]/70'
      : 'text-[var(--text-muted)]/55 group-hover:text-[var(--text-secondary)]';

  return (
    <div className="group">
      <button
        type="button"
        onClick={() => canExpand && setExpanded((v) => !v)}
        disabled={!canExpand}
        title={safeTitle(entry.detail || entry.summary)}
        className={`flex w-full items-baseline gap-1.5 py-0.5 text-left text-[12px] leading-5 transition-colors disabled:opacity-100 ${
          canExpand ? '' : 'cursor-default'
        }`}
      >
        <span className={`min-w-0 flex-1 truncate ${summaryClass}`}>{entry.summary}</span>
        <RightStatusGlyph entry={entry} canExpand={canExpand} expanded={expanded} />
      </button>

      {showChangeHint && changeRecord ? (
        <EditedFileHint record={changeRecord} onOpen={onOpenDiff} />
      ) : null}

      {expanded && canExpand ? (
        <div className="mb-1 ml-1 border-l border-[var(--border)]/50 pl-3">
          <ToolEntryDetail entry={entry} />
        </div>
      ) : null}
    </div>
  );
}

function RightStatusGlyph({
  entry,
  canExpand,
  expanded,
}: {
  entry: Extract<WorkstreamEntry, { type: 'tool' | 'task' | 'memory' }>;
  canExpand: boolean;
  expanded: boolean;
}) {
  if (entry.status === 'pending') {
    return <LoaderCircle className="h-3 w-3 flex-shrink-0 animate-spin text-[var(--text-muted)]/55" />;
  }
  if (entry.status === 'error') {
    return <CircleX className="h-3 w-3 flex-shrink-0 text-[var(--error)]" />;
  }
  if (!canExpand) return null;
  return (
    <ChevronRight
      className={`h-3 w-3 flex-shrink-0 text-[var(--text-muted)]/45 transition-transform ${
        expanded ? 'rotate-90' : ''
      }`}
    />
  );
}

function EditedFileHint({
  record,
  onOpen,
}: {
  record: ChangeRecord;
  onOpen?: (record: ChangeRecord) => void;
}) {
  const verb =
    record.operation === 'write' ? 'Created' : record.operation === 'delete' ? 'Deleted' : 'Edited';
  const clickable = Boolean(onOpen);
  const fileName = record.fileName || record.filePath;

  const body = (
    <>
      <span className="text-[var(--text-muted)]/60">{verb}</span>
      <span
        className={`max-w-[28rem] truncate font-mono ${
          clickable ? 'text-[var(--accent)] group-hover:underline' : 'text-[var(--text-secondary)]'
        }`}
      >
        {fileName}
      </span>
      {record.addedLines + record.removedLines > 0 ? (
        <DiffStatLabel additions={record.addedLines} deletions={record.removedLines} />
      ) : null}
    </>
  );

  if (clickable) {
    return (
      <button
        type="button"
        onClick={() => onOpen?.(record)}
        title={record.filePath}
        className="group ml-0.5 mt-0.5 inline-flex items-baseline gap-1.5 text-left text-[11px] leading-5 transition-opacity"
      >
        {body}
      </button>
    );
  }
  return (
    <div
      title={record.filePath}
      className="ml-0.5 mt-0.5 inline-flex items-baseline gap-1.5 text-[11px] leading-5"
    >
      {body}
    </div>
  );
}

// ── Tool detail (args / output / diff), shown when row is expanded ──────────

function hasEntryDetail(
  entry: Extract<WorkstreamEntry, { type: 'tool' | 'task' | 'memory' }>
): boolean {
  const inputRecord = isRecord(entry.block.input) ? getPublicToolInput(entry.block.input) : {};
  return Boolean(
    entry.detail || entry.result || Object.keys(inputRecord).length
  );
}

function ToolEntryDetail({
  entry,
}: {
  entry: Extract<WorkstreamEntry, { type: 'tool' | 'task' | 'memory' }>;
}) {
  const [showArgs, setShowArgs] = useState(false);
  const [showOutput, setShowOutput] = useState(false);
  const inputRecord = isRecord(entry.block.input) ? getPublicToolInput(entry.block.input) : {};
  const hasArgs = Object.keys(inputRecord).length > 0;
  const contentStr = getToolResultOutputContent(entry.result);
  const hasOutput = contentStr.length > 0;
  const outputLines = hasOutput ? contentStr.split('\n').length : 0;
  const displayContentStr = truncateWithNotice(contentStr, MAX_TOOL_OUTPUT_CHARS);
  const diffContent =
    entry.toolName === 'Write' || entry.toolName === 'Edit' || entry.toolName === 'Delete'
      ? getToolResultDiffContent(entry.result)
      : null;
  const diffFilePath =
    (diffContent ? extractUnifiedDiffFilePath(diffContent) : null) || getToolInputFilePath(inputRecord);
  const diffHunks = useMemo(() => {
    if (diffContent) {
      return parseUnifiedDiff(diffContent);
    }
    if (entry.toolName === 'Edit') {
      const oldText = getToolInputOldText(inputRecord);
      const newText = getToolInputNewText(inputRecord);
      if (oldText !== null && newText !== null) {
        return createUnifiedDiffHunks(oldText, newText, { contextLines: 3 });
      }
    }
    if (entry.toolName === 'Write') {
      const content = getToolInputContent(inputRecord);
      if (content) {
        return buildWritePreviewHunks(content);
      }
    }
    return [];
  }, [diffContent, entry.toolName, inputRecord]);

  return (
    <div className="my-1 space-y-2 text-[12px]">
      {hasArgs ? (
        <CollapsibleSection
          label="Arguments"
          expanded={showArgs}
          onToggle={() => setShowArgs((v) => !v)}
        >
          <pre className="whitespace-pre-wrap break-all text-[12px] leading-5 text-[var(--text-secondary)]">
            {safeJsonStringify(entry.block.input, 2)}
          </pre>
        </CollapsibleSection>
      ) : null}

      {diffHunks.length > 0 ? (
        <div>
          <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-muted)]">
            {diffFilePath || entry.summary}
          </div>
          <div className="overflow-hidden border border-[var(--border)]/45 bg-[var(--bg-secondary)]/35">
            <div className="max-h-72 overflow-auto">
              {diffHunks.map((hunk, index) => (
                <DiffHunkView key={`${hunk.oldStart}-${hunk.newStart}-${index}`} hunk={hunk} />
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {hasOutput ? (
        <CollapsibleSection
          label={diffHunks.length > 0 ? 'Raw output' : `Output (${outputLines} line${outputLines > 1 ? 's' : ''})`}
          expanded={showOutput}
          onToggle={() => setShowOutput((v) => !v)}
          isError={entry.result?.is_error}
        >
          <pre
            className={`whitespace-pre-wrap break-all text-[12px] leading-5 ${
              entry.result?.is_error ? 'text-[var(--error)]' : 'text-[var(--text-secondary)]'
            }`}
          >
            {displayContentStr}
          </pre>
        </CollapsibleSection>
      ) : entry.detail ? (
        <pre className="whitespace-pre-wrap break-words text-[12px] leading-6 text-[var(--text-secondary)]">
          {truncateWithNotice(entry.detail, MAX_TRACE_TEXT_CHARS)}
        </pre>
      ) : null}
    </div>
  );
}

function CollapsibleSection({
  label,
  expanded,
  onToggle,
  isError,
  children,
}: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
  isError?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-[var(--border)]/45 bg-[var(--bg-secondary)]/35">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left"
      >
        <span
          className={`text-[11px] font-medium uppercase tracking-[0.08em] ${
            isError ? 'text-[var(--error)]' : 'text-[var(--text-muted)]'
          }`}
        >
          {label}
        </span>
        <ChevronRight
          className={`h-3 w-3 text-[var(--text-muted)] transition-transform ${
            expanded ? 'rotate-90' : ''
          }`}
        />
      </button>
      {expanded ? <div className="border-t border-[var(--border)]/60 px-3 py-2">{children}</div> : null}
    </div>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getPublicToolInput(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => !key.startsWith('__aegis'))
  );
}

function truncateWithNotice(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars).trimEnd()}\n\n[Output truncated by Aegis: ${omitted.toLocaleString()} characters hidden]`;
}

function safeTitle(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return truncateWithNotice(value, MAX_TITLE_CHARS);
}

function buildWritePreviewHunks(content: string): UnifiedDiffHunk[] {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return [
    {
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: lines.length,
      lines: lines.map((line, index) => ({
        type: 'addition',
        oldLineNumber: null,
        newLineNumber: index + 1,
        text: line,
      })),
    },
  ];
}

function DiffHunkView({ hunk }: { hunk: UnifiedDiffHunk }) {
  return (
    <div className="border-t border-[var(--border)]/50 first:border-t-0">
      <div className="px-3 py-1 font-mono text-[11px] text-[var(--text-muted)]">
        {`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`}
      </div>
      {hunk.lines.map((line, index) => (
        <DiffLineView key={`${hunk.oldStart}-${hunk.newStart}-${index}`} line={line} />
      ))}
    </div>
  );
}

function DiffLineView({ line }: { line: UnifiedDiffLine }) {
  const containerClass =
    line.type === 'addition'
      ? 'bg-emerald-500/10'
      : line.type === 'deletion'
        ? 'bg-rose-500/10'
        : 'bg-transparent';
  const markerClass =
    line.type === 'addition'
      ? 'text-emerald-400'
      : line.type === 'deletion'
        ? 'text-rose-400'
        : 'text-[var(--text-muted)]';
  const marker = line.type === 'addition' ? '+' : line.type === 'deletion' ? '-' : ' ';
  return (
    <div
      className={`grid grid-cols-[56px_56px_18px_minmax(0,1fr)] items-start gap-0 font-mono text-[12px] leading-6 ${containerClass}`}
    >
      <div className="px-2 text-right text-[var(--text-muted)]">{line.oldLineNumber ?? ''}</div>
      <div className="px-2 text-right text-[var(--text-muted)]">{line.newLineNumber ?? ''}</div>
      <div className={`px-1 text-center ${markerClass}`}>{marker}</div>
      <div className="min-w-0 whitespace-pre-wrap break-words px-2 text-[var(--text-primary)]">
        {line.text || ' '}
      </div>
    </div>
  );
}

// ── Live "Working for Xs" footer (used by ChatPane below the trace) ─────────

export function WorkingFooter({ startedAt, label = 'Working' }: { startedAt: number | undefined; label?: string }) {
  const [now, setNow] = useState(() => Date.now());

  // Only run the live timer when we actually have a start anchor — otherwise
  // we'd burn a setInterval per render with nothing to display.
  useEffect(() => {
    if (typeof startedAt !== 'number') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  if (typeof startedAt !== 'number') {
    return (
      <div className="my-2 flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]/70">
        <span>{label}…</span>
        <PulsingDots />
      </div>
    );
  }

  const elapsedMs = Math.max(0, now - startedAt);
  const elapsed = formatElapsed(elapsedMs);
  return (
    <div className="my-2 flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]/70">
      <span>
        {label} for {elapsed}
      </span>
      <PulsingDots />
    </div>
  );
}

function PulsingDots() {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="h-1 w-1 rounded-full bg-[var(--text-muted)]/40 animate-pulse [animation-delay:0ms]" />
      <span className="h-1 w-1 rounded-full bg-[var(--text-muted)]/40 animate-pulse [animation-delay:150ms]" />
      <span className="h-1 w-1 rounded-full bg-[var(--text-muted)]/40 animate-pulse [animation-delay:300ms]" />
    </span>
  );
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

// ── Response divider ("Response · Worked for Xs") ───────────────────────────

export function ResponseDivider({ durationMs }: { durationMs: number | undefined }) {
  const elapsed = typeof durationMs === 'number' ? formatElapsed(durationMs) : null;
  return (
    <div className="my-4 flex items-center gap-3 px-1">
      <div className="h-px flex-1 bg-[var(--border)]/60" />
      <span className="text-[11px] tracking-[0.04em] text-[var(--text-muted)]/80">
        Response{elapsed ? ` · Worked for ${elapsed}` : ''}
      </span>
      <div className="h-px flex-1 bg-[var(--border)]/60" />
    </div>
  );
}

// Re-export utility types for callers that import alongside.
export type { ToolResultBlock, ToolUseBlock };

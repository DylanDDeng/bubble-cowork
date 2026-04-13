import { useEffect, useMemo, useState } from 'react';
import {
  Brain,
  Check,
  ChevronDown,
  CircleAlert,
  CircleX,
  Database,
  LoaderCircle,
  ShieldAlert,
  Wrench,
} from 'lucide-react';
import type { ToolStatus } from '../types';
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

interface AssistantWorkstreamProps {
  model: WorkstreamModel;
  className?: string;
}

export function AssistantWorkstream({ model, className = '' }: AssistantWorkstreamProps) {
  const [expanded, setExpanded] = useState(
    model.state === 'waiting' || model.state === 'error'
  );

  useEffect(() => {
    if (model.state === 'waiting' || model.state === 'error') {
      setExpanded(true);
    }
  }, [model.state]);

  const visibleEntries = expanded ? model.entries : model.previewEntries;
  const showToggle = model.entries.length > model.previewEntries.length || model.entries.length > 3;
  const meta = useMemo(() => buildWorkstreamMeta(model), [model]);

  if (model.entries.length === 0 && !model.todoProgress && model.summary.trim().length === 0) {
    return null;
  }

  if (model.entries.length === 0 && model.todoProgress) {
    return <TodoProgressCard state={model.todoProgress} className={className || 'my-2'} />;
  }

  return (
    <div className={`my-2 border-l border-[var(--border)]/60 pl-3 ${className}`}>
      <div className="flex items-start gap-3 py-1.5">
        <StatusGlyph state={model.state} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-medium text-[var(--text-primary)]">{model.title}</div>
              <div className="mt-0.5 text-[12px] leading-5 text-[var(--text-secondary)]">{model.summary}</div>
            </div>
            {showToggle ? (
              <button
                type="button"
                onClick={() => setExpanded((current) => !current)}
                className="inline-flex h-6 items-center gap-1 px-1 text-[11px] font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
                aria-expanded={expanded}
              >
                <span>{expanded ? 'Hide details' : `Show ${model.hiddenEntryCount} more`}</span>
                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
              </button>
            ) : null}
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-muted)]">
            {meta.map((item) => (
              <span
                key={item}
                className="rounded-full bg-[var(--bg-tertiary)]/55 px-2 py-0.5"
              >
                {item}
              </span>
            ))}
          </div>
        </div>
      </div>

      {model.todoProgress ? (
        <div className="mt-2 border-t border-[var(--border)]/35 py-3 pr-0">
          <TodoProgressCard state={model.todoProgress} />
        </div>
      ) : null}

      {visibleEntries.length > 0 ? (
        <div className="mt-2 border-t border-[var(--border)]/35 py-2 pr-0">
          <div className="space-y-0.5">
            {visibleEntries.map((entry) => (
              <WorkstreamEntryRow key={entry.id} entry={entry} expandedMode={expanded} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function buildWorkstreamMeta(model: WorkstreamModel): string[] {
  const items: string[] = [];
  if (model.toolCount > 0) {
    items.push(`${model.toolCount} tool${model.toolCount > 1 ? 's' : ''}`);
  }
  if (model.noteCount > 0) {
    items.push(`${model.noteCount} note${model.noteCount > 1 ? 's' : ''}`);
  }
  return items;
}

function StatusGlyph({ state }: { state: WorkstreamModel['state'] }) {
  if (state === 'waiting') {
    return (
      <span className="mt-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-amber-500/14 text-amber-600">
        <ShieldAlert className="h-3 w-3" />
      </span>
    );
  }
  if (state === 'error') {
    return (
      <span className="mt-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-[var(--error)]/14 text-[var(--error)]">
        <CircleX className="h-3.5 w-3.5" />
      </span>
    );
  }
  if (state === 'running') {
    return <LoaderCircle className="mt-0.5 h-4 w-4 flex-shrink-0 animate-spin text-[var(--accent)]" />;
  }
  return (
    <span className="mt-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-emerald-500/14 text-emerald-600">
      <Check className="h-3 w-3" />
    </span>
  );
}

function WorkstreamEntryRow({
  entry,
  expandedMode,
}: {
  entry: WorkstreamEntry;
  expandedMode: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = expandedMode && hasEntryDetail(entry);

  useEffect(() => {
    if (!expandedMode) {
      setExpanded(false);
    }
  }, [expandedMode]);

  const { icon, tone, meta, summary } = getEntryPresentation(entry);

  return (
    <div className="px-0 py-0.5">
      <div className="flex items-start gap-2">
        <div className={`mt-1 flex h-4 w-4 flex-shrink-0 items-center justify-center ${tone.icon}`}>
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <div className={`min-w-0 flex-1 ${tone.summary}`}>{summary}</div>
            {meta ? <div className={`flex-shrink-0 text-[11px] ${tone.meta}`}>{meta}</div> : null}
            {canExpand ? (
              <button
                type="button"
                onClick={() => setExpanded((current) => !current)}
                className="flex-shrink-0 text-[11px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
              >
                {expanded ? 'Less' : 'More'}
              </button>
            ) : null}
          </div>

          {expandedMode ? (
            <div className="mt-0.5 text-[11px] leading-5 text-[var(--text-muted)]">
              {getEntrySecondaryText(entry)}
            </div>
          ) : null}

          {expandedMode && expanded && hasEntryDetail(entry) ? (
            <div className="mt-2 border-l border-[var(--border)]/50 pl-3">
              <WorkstreamEntryDetail entry={entry} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function getEntryPresentation(entry: WorkstreamEntry) {
  if (entry.type === 'thinking') {
    return {
      icon: <Brain className="h-3.5 w-3.5" />,
      tone: {
        icon: 'text-[var(--text-muted)]',
        summary: 'text-[12px] leading-5 text-[var(--text-secondary)]/90',
        meta: 'text-[var(--text-muted)]',
      },
      summary: entry.summary,
      meta: entry.state === 'active' ? 'live' : null,
    };
  }

  if (entry.type === 'note') {
    return {
      icon: <span className="h-1.5 w-1.5 rounded-full bg-current" />,
      tone: {
        icon: 'text-[var(--text-muted)]',
        summary: 'text-[12px] leading-5 text-[var(--text-secondary)]',
        meta: 'text-[var(--text-muted)]',
      },
      summary: entry.summary,
      meta: null,
    };
  }

  if (entry.type === 'approval') {
    return {
      icon:
        entry.state === 'approved' ? (
          <StatusCircleIcon kind="success" />
        ) : entry.state === 'denied' ? (
          <StatusCircleIcon kind="error" />
        ) : (
          <StatusCircleIcon kind="waiting" />
        ),
      tone: {
        icon: '',
        summary: 'text-[12px] font-medium leading-5 text-[var(--text-primary)]',
        meta: 'text-[var(--text-muted)]',
      },
      summary: entry.summary,
      meta: entry.state === 'approved' ? 'approved' : entry.state === 'denied' ? 'denied' : 'waiting',
    };
  }

  const statusTone =
    entry.status === 'error'
      ? 'text-[var(--error)]'
      : entry.status === 'pending'
        ? 'text-[var(--accent)]'
        : entry.type === 'memory'
          ? 'text-violet-500'
          : entry.type === 'task'
            ? 'text-sky-500'
            : 'text-[var(--text-primary)]';

  return {
    icon:
      entry.status === 'success' ? (
        <StatusCircleIcon kind="success" />
      ) : entry.status === 'error' ? (
        <StatusCircleIcon kind="error" />
      ) : entry.status === 'pending' ? (
        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
      ) : entry.type === 'memory' ? (
        <Database className="h-3.5 w-3.5" />
      ) : (
        <Wrench className="h-3.5 w-3.5" />
      ),
    tone: {
      icon: statusTone,
      summary: `text-[12px] leading-5 ${entry.status === 'error' ? 'text-[var(--error)]' : 'text-[var(--text-primary)]'}`,
      meta: 'text-[var(--text-muted)]',
    },
    summary: entry.summary,
    meta: entry.status,
  };
}

function StatusCircleIcon({
  kind,
}: {
  kind: 'success' | 'error' | 'waiting';
}) {
  if (kind === 'success') {
    return (
      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500/14 text-emerald-600">
        <Check className="h-3 w-3" />
      </span>
    );
  }

  if (kind === 'error') {
    return (
      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-[var(--error)]/14 text-[var(--error)]">
        <CircleX className="h-3.5 w-3.5" />
      </span>
    );
  }

  return (
    <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-amber-500/14 text-amber-600">
      <ShieldAlert className="h-3 w-3" />
    </span>
  );
}

function getEntrySecondaryText(entry: WorkstreamEntry): string | null {
  if (entry.type === 'tool' || entry.type === 'task' || entry.type === 'memory') {
    const fallback = entry.type === 'memory' ? 'Memory action' : entry.type === 'task' ? 'Task' : entry.toolName;
    return entry.toolName || fallback;
  }

  if (entry.type === 'approval') {
    return entry.detail || null;
  }

  return null;
}

function hasEntryDetail(entry: WorkstreamEntry): boolean {
  if (entry.type === 'tool' || entry.type === 'task' || entry.type === 'memory') {
    return true;
  }

  return Boolean(entry.detail && entry.detail.trim() && entry.detail.trim() !== entry.summary.trim());
}

function WorkstreamEntryDetail({ entry }: { entry: WorkstreamEntry }) {
  if (entry.type === 'thinking' || entry.type === 'note' || entry.type === 'approval' || entry.type === 'error') {
    return (
      <pre className="whitespace-pre-wrap break-words text-[12px] leading-6 text-[var(--text-secondary)]">
        {entry.detail || entry.summary}
      </pre>
    );
  }

  return <ToolLikeEntryDetail entry={entry} />;
}

function ToolLikeEntryDetail({
  entry,
}: {
  entry: Extract<WorkstreamEntry, { type: 'tool' | 'task' | 'memory' }>;
}) {
  const [showArgs, setShowArgs] = useState(false);
  const [showOutput, setShowOutput] = useState(false);
  const inputRecord = isRecord(entry.block.input) ? entry.block.input : {};
  const hasArgs = Object.keys(inputRecord).length > 0;
  const contentStr =
    entry.result?.content != null
      ? typeof entry.result.content === 'string'
        ? entry.result.content
        : safeJsonStringify(entry.result.content)
      : '';
  const hasOutput = contentStr.length > 0;
  const outputLines = hasOutput ? contentStr.split('\n').length : 0;
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
    <div className="space-y-2 text-[12px]">
      {hasArgs ? (
        <CollapsibleSection
          label="Arguments"
          expanded={showArgs}
          onToggle={() => setShowArgs((current) => !current)}
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
          onToggle={() => setShowOutput((current) => !current)}
          isError={entry.result?.is_error}
        >
          <pre
            className={`whitespace-pre-wrap break-all text-[12px] leading-5 ${
              entry.result?.is_error ? 'text-[var(--error)]' : 'text-[var(--text-secondary)]'
            }`}
          >
            {contentStr}
          </pre>
        </CollapsibleSection>
      ) : entry.detail ? (
        <pre className="whitespace-pre-wrap break-words text-[12px] leading-6 text-[var(--text-secondary)]">
          {entry.detail}
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
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
      >
        <span className={`text-[11px] font-medium uppercase tracking-[0.08em] ${isError ? 'text-[var(--error)]' : 'text-[var(--text-muted)]'}`}>
          {label}
        </span>
        <ChevronDown className={`h-3.5 w-3.5 text-[var(--text-muted)] transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>
      {expanded ? <div className="border-t border-[var(--border)]/60 px-3 py-3">{children}</div> : null}
    </div>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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
      <div className="px-3 py-1.5 font-mono text-[11px] text-[var(--text-muted)]">
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
    <div className={`grid grid-cols-[56px_56px_18px_minmax(0,1fr)] items-start gap-0 font-mono text-[12px] leading-6 ${containerClass}`}>
      <div className="px-2 text-right text-[var(--text-muted)]">{line.oldLineNumber ?? ''}</div>
      <div className="px-2 text-right text-[var(--text-muted)]">{line.newLineNumber ?? ''}</div>
      <div className={`px-1 text-center ${markerClass}`}>{marker}</div>
      <div className="min-w-0 whitespace-pre-wrap break-words px-2 text-[var(--text-primary)]">{line.text || ' '}</div>
    </div>
  );
}

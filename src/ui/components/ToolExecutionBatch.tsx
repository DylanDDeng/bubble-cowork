import { useEffect, useRef, useState, useMemo } from 'react';
import { Brain, CheckCircle2, ChevronRight, Circle, LoaderCircle } from 'lucide-react';
import type { ContentBlock, ToolStatus, StreamMessage } from '../types';
import { getToolSummary, safeJsonStringify } from '../utils/tool-summary';
import { getMessageContentBlocks } from '../utils/message-content';
import { extractLatestTodoProgress } from '../utils/todo-progress';
import {
  createUnifiedDiffHunks,
  extractUnifiedDiffFilePath,
  parseUnifiedDiff,
  type UnifiedDiffHunk,
  type UnifiedDiffLine,
} from '../utils/unified-diff';
import { TodoProgressCard } from './TodoProgressCard';

// 工具使用块类型
type ToolUseBlock = ContentBlock & { type: 'tool_use' };
// 工具结果块类型
type ToolResultBlock = ContentBlock & { type: 'tool_result' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
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

function getToolResultDiffContent(result: ToolResultBlock | undefined): string | null {
  const payload = parseToolResultPayload(result);
  const metadata = isRecord(payload?.metadata) ? payload.metadata : null;
  return getString(metadata?.diff);
}

function getToolInputFilePath(input: Record<string, unknown>): string | null {
  return getString(input.file_path) || getString(input.path) || getString(input.filePath) || getString(input.filename);
}

function getToolInputContent(input: Record<string, unknown>): string | null {
  return getString(input.content) || getString(input.text) || getString(input.data) || getString(input.file_content);
}

function getToolInputOldText(input: Record<string, unknown>): string | null {
  return (
    getString(input.old_string) ||
    getString(input.oldText) ||
    getString(input.old_text) ||
    getString(input.search) ||
    getString(input.before) ||
    getString(input.original)
  );
}

function getToolInputNewText(input: Record<string, unknown>): string | null {
  return (
    getString(input.new_string) ||
    getString(input.newText) ||
    getString(input.new_text) ||
    getString(input.replace) ||
    getString(input.replacement) ||
    getString(input.after) ||
    getString(input.updated)
  );
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

interface ToolExecutionBatchProps {
  messages: (StreamMessage & { type: 'assistant' })[];
  toolStatusMap: Map<string, ToolStatus>;
  toolResultsMap: Map<string, ToolResultBlock>;
  isSessionRunning: boolean;
}

type TraceEntry =
  | { type: 'thinking'; id: string; content: string }
  | { type: 'note'; id: string; content: string }
  | { type: 'tool'; id: string; block: ToolUseBlock };

// 从 assistant 消息中提取所有 tool_use 块
function extractToolBlocks(
  messages: (StreamMessage & { type: 'assistant' })[]
): ToolUseBlock[] {
  const blocks: ToolUseBlock[] = [];
  for (const msg of messages) {
    for (const block of getMessageContentBlocks(msg)) {
      if (block.type === 'tool_use') {
        blocks.push(block as ToolUseBlock);
      }
    }
  }
  return blocks;
}

function extractTraceEntries(
  messages: (StreamMessage & { type: 'assistant' })[]
): TraceEntry[] {
  const entries: TraceEntry[] = [];

  for (const msg of messages) {
    for (const block of getMessageContentBlocks(msg)) {
      if (block.type === 'thinking' && block.thinking?.trim()) {
        entries.push({
          type: 'thinking',
          id: `thinking-${entries.length}`,
          content: block.thinking.trim(),
        });
      } else if (block.type === 'text' && block.text?.trim()) {
        entries.push({
          type: 'note',
          id: `note-${entries.length}`,
          content: block.text.trim(),
        });
      } else if (block.type === 'tool_use') {
        entries.push({
          type: 'tool',
          id: block.id,
          block: block as ToolUseBlock,
        });
      }
    }
  }

  return entries;
}

// 统计工具类型
function countToolTypes(blocks: ToolUseBlock[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const block of blocks) {
    counts.set(block.name, (counts.get(block.name) || 0) + 1);
  }
  return counts;
}

// 计算批次整体状态
function getBatchStatus(
  blocks: ToolUseBlock[],
  toolStatusMap: Map<string, ToolStatus>
): ToolStatus {
  let hasError = false;
  let allSuccess = true;

  for (const block of blocks) {
    const status = toolStatusMap.get(block.id);
    if (status === 'error') hasError = true;
    if (status !== 'success') allSuccess = false;
  }

  if (hasError) return 'error';
  if (allSuccess) return 'success';
  return 'pending';
}

// 获取批次摘要（基于 Task 工具或第一个工具）
function getBatchSummary(blocks: ToolUseBlock[]): string {
  if (blocks.length === 0) return '';

  // 查找 Task 工具的 description
  const taskBlock = blocks.find((b) => b.name === 'Task');
  if (taskBlock) {
    const summary = getToolSummary('Task', taskBlock.input);
    if (summary) return summary;
  }

  // 否则返回空（使用默认文案）
  return '';
}

/**
 * ToolExecutionBatch - 聚合多个连续的工具执行消息
 * 将多个 assistant 消息中的工具调用合并显示，减少视觉混乱
 */
export function ToolExecutionBatch({
  messages,
  toolStatusMap,
  toolResultsMap,
  isSessionRunning,
}: ToolExecutionBatchProps) {
  const allBlocks = useMemo(() => extractToolBlocks(messages), [messages]);
  const traceEntries = useMemo(() => extractTraceEntries(messages), [messages]);

  const hasPendingTools = useMemo(
    () => allBlocks.some((block) => toolStatusMap.get(block.id) === 'pending'),
    [allBlocks, toolStatusMap]
  );
  const [expanded, setExpanded] = useState(hasPendingTools);
  const previousRunningRef = useRef(isSessionRunning);

  useEffect(() => {
    if (hasPendingTools) {
      setExpanded(true);
    }
  }, [hasPendingTools]);

  useEffect(() => {
    if (previousRunningRef.current && !isSessionRunning) {
      setExpanded(false);
    }
    previousRunningRef.current = isSessionRunning;
  }, [isSessionRunning]);

  // 过滤掉 TodoWrite（内部状态管理工具）
  const visibleBlocks = useMemo(
    () => allBlocks.filter((b) => b.name !== 'TodoWrite'),
    [allBlocks]
  );
  const todoWriteCount = allBlocks.length - visibleBlocks.length;
  const todoProgress = useMemo(
    () => extractLatestTodoProgress(allBlocks),
    [allBlocks]
  );

  // 统计工具类型（不含 TodoWrite）
  const toolCounts = useMemo(
    () => countToolTypes(visibleBlocks),
    [visibleBlocks]
  );

  // 整体状态
  const batchStatus = useMemo(
    () => getBatchStatus(allBlocks, toolStatusMap),
    [allBlocks, toolStatusMap]
  );

  // 批次摘要
  const summary = useMemo(() => getBatchSummary(allBlocks), [allBlocks]);

  const totalTools = visibleBlocks.length;
  const thinkingCount = traceEntries.filter((entry) => entry.type === 'thinking').length;
  const noteCount = traceEntries.filter((entry) => entry.type === 'note').length;
  const completedTools = visibleBlocks.filter(
    (block) => toolStatusMap.get(block.id) === 'success'
  ).length;
  const runningTools = visibleBlocks.filter(
    (block) => toolStatusMap.get(block.id) === 'pending'
  ).length;

  const headerSummary =
    totalTools > 0
      ? runningTools > 0
        ? `${runningTools} running · ${completedTools}/${totalTools} completed`
        : `${completedTools}/${totalTools} completed`
      : thinkingCount > 0
        ? `${thinkingCount} thinking note${thinkingCount > 1 ? 's' : ''}`
        : '';

  // 如果没有可见工具（全是 TodoWrite），显示简化版本
  if (totalTools === 0 && todoProgress && thinkingCount === 0) {
    return (
      <TodoProgressCard state={todoProgress} className="my-2" />
    );
  }

  return (
    <div className="my-2 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]/70">
      {/* 折叠头部 */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-[var(--bg-tertiary)]/25"
      >
        <ChevronIcon expanded={expanded} />
        <span className="font-medium text-sm text-[var(--text-primary)]">
          {summary || 'Execution trace'}
        </span>
        {headerSummary && (
          <span className="text-sm text-[var(--text-muted)]">{headerSummary}</span>
        )}
        <div className="flex-1" />
        <div className="text-xs text-[var(--text-muted)]">
          {totalTools > 0 ? `${totalTools} tool call${totalTools > 1 ? 's' : ''}` : `${thinkingCount} note${thinkingCount > 1 ? 's' : ''}`}
          {thinkingCount > 0 && totalTools > 0 ? `, ${thinkingCount} thinking` : ''}
          {noteCount > 0 ? `${totalTools > 0 || thinkingCount > 0 ? ', ' : ''}${noteCount} note${noteCount > 1 ? 's' : ''}` : ''}
        </div>
      </button>

      {/* 展开内容 */}
      {expanded && (
        <div className="border-t border-[var(--border)]/70 px-3 py-2">
          {todoProgress && (
            <TodoProgressCard state={todoProgress} className="mb-3" />
          )}

          <div className="space-y-1.5">
            {traceEntries
              .filter((entry) =>
                entry.type === 'thinking' ||
                entry.type === 'note' ||
                (entry.type === 'tool' && entry.block.name !== 'TodoWrite')
              )
              .map((entry) =>
                entry.type === 'thinking' ? (
                  <ThinkingTraceItem key={entry.id} content={entry.content} />
                ) : entry.type === 'note' ? (
                  <TraceNoteItem key={entry.id} content={entry.content} />
                ) : (
                  <ToolInvocationCompact
                    key={entry.id}
                    block={entry.block}
                    result={toolResultsMap.get(entry.block.id)}
                    status={toolStatusMap.get(entry.block.id) || 'pending'}
                  />
                )
              )}
          </div>
        </div>
      )}
    </div>
  );
}

// 紧凑的工具调用显示
function ToolInvocationCompact({
  block,
  result,
  status,
}: {
  block: ToolUseBlock;
  result?: ToolResultBlock;
  status: ToolStatus;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const summary = getToolSummary(block.name, block.input);
  const inputRecord = isRecord(block.input) ? block.input : {};
  // 安全检查：确保 content 是字符串
  const contentStr = result?.content != null
    ? (typeof result.content === 'string' ? result.content : safeJsonStringify(result.content))
    : '';
  const hasOutput = contentStr.length > 0;
  const outputLines = hasOutput ? contentStr.split('\n').length : 0;
  const diffContent =
    (block.name === 'Write' || block.name === 'Edit' || block.name === 'Delete')
      ? getToolResultDiffContent(result)
      : null;
  const diffFilePath =
    (diffContent ? extractUnifiedDiffFilePath(diffContent) : null) || getToolInputFilePath(inputRecord);
  const diffHunks = useMemo(() => {
    if (diffContent) {
      return parseUnifiedDiff(diffContent);
    }

    if (block.name === 'Edit') {
      const oldText = getToolInputOldText(inputRecord);
      const newText = getToolInputNewText(inputRecord);
      if (oldText !== null && newText !== null) {
        return createUnifiedDiffHunks(oldText, newText, { contextLines: 3 });
      }
    }

    if (block.name === 'Write') {
      const content = getToolInputContent(inputRecord);
      if (content) {
        return buildWritePreviewHunks(content);
      }
    }

    return [];
  }, [block.name, diffContent, inputRecord]);
  const hasStructuredDiff = diffHunks.length > 0;

  return (
    <div className="rounded-lg border border-[var(--border)]/70 bg-[var(--bg-primary)]/80">
      <div
        className="flex items-center gap-2 rounded-lg px-3 py-2.5 transition-colors hover:bg-[var(--bg-tertiary)]/20"
        onClick={() => setShowDetails(!showDetails)}
      >
        <ChevronRight
          className={`h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)] transition-transform ${showDetails ? 'rotate-90' : ''}`}
        />
        <ToolStatusIcon status={status} />
        <span className="text-sm font-medium text-[var(--text-primary)]">{block.name}</span>
        <span className="truncate text-sm text-[var(--text-secondary)] flex-1">
          {summary}
        </span>
        <span className="text-xs text-[var(--text-muted)]">
          {hasOutput ? `${outputLines} line${outputLines > 1 ? 's' : ''}` : 'No output'}
        </span>
      </div>

      {/* 展开详情 */}
      {showDetails && (
        <div className="border-t border-[var(--border)]/60 px-3 py-2 text-xs">
          {/* 参数 */}
          <div className="mb-1">
            <span className="text-[var(--text-muted)]">Args:</span>
            <pre className="mt-0.5 p-2 bg-[var(--bg-tertiary)] rounded text-[var(--text-secondary)] whitespace-pre-wrap break-all max-h-32 overflow-auto">
              {safeJsonStringify(block.input, 2)}
            </pre>
          </div>

          {hasStructuredDiff && (
            <div className="mb-1">
              <span className="text-[var(--text-muted)]">Content:</span>
              <div className="mt-1 overflow-hidden rounded-xl border border-[var(--border)]/70 bg-[var(--bg-tertiary)]/60">
                <div className="border-b border-[var(--border)]/70 px-3 py-2 text-sm font-medium text-[var(--text-primary)]">
                  {diffFilePath || summary || block.name}
                </div>
                <div className="max-h-72 overflow-auto">
                  {diffHunks.map((hunk, index) => (
                    <DiffHunkView key={`${hunk.oldStart}-${hunk.newStart}-${index}`} hunk={hunk} />
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* 输出 */}
          {hasOutput && (
            <details className="mt-2">
              <summary className={`cursor-pointer select-none ${result?.is_error ? 'text-red-400' : 'text-[var(--text-muted)]'}`}>
                {hasStructuredDiff ? 'Raw output' : 'Output'}
              </summary>
              <pre
                className={`mt-0.5 p-2 bg-[var(--bg-tertiary)] rounded whitespace-pre-wrap break-all max-h-32 overflow-auto ${
                  result?.is_error ? 'text-red-400' : 'text-[var(--text-secondary)]'
                }`}
              >
                {contentStr}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function ThinkingTraceItem({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview =
    content.length > 140
      ? `${content.slice(0, 140).trimEnd()}...`
      : content;

  return (
    <div className="rounded-lg border border-[var(--border)]/70 bg-[var(--bg-primary)]/80">
      <button
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-start gap-2 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-[var(--bg-tertiary)]/20"
      >
        <ChevronRight
          className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)] transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        <Brain className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--text-muted)]" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-[var(--text-primary)]">Thinking</div>
          <div className="mt-0.5 text-sm leading-5 text-[var(--text-secondary)]">
            {expanded ? content : preview}
          </div>
        </div>
      </button>
    </div>
  );
}

function TraceNoteItem({ content }: { content: string }) {
  return (
    <div className="px-1 py-0.5 text-sm leading-6 text-[var(--text-secondary)]">
      {content}
    </div>
  );
}

function DiffHunkView({ hunk }: { hunk: UnifiedDiffHunk }) {
  return (
    <div className="border-t border-[var(--border)]/60 first:border-t-0">
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


function ToolStatusIcon({ status }: { status: ToolStatus }) {
  if (status === 'success') {
    return <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-[var(--success)]" />;
  }
  if (status === 'error') {
    return <Circle className="h-4 w-4 flex-shrink-0 text-[var(--error)]" />;
  }
  return <LoaderCircle className="h-4 w-4 flex-shrink-0 animate-spin text-[var(--accent)]" />;
}

// 展开/折叠箭头图标
function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`chevron-icon w-4 h-4 text-[var(--text-muted)] flex-shrink-0 ${
        expanded ? 'expanded' : ''
      }`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
    </svg>
  );
}

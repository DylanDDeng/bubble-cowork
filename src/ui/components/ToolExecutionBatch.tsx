import { useState, useMemo } from 'react';
import type { ContentBlock, ToolStatus, StreamMessage } from '../types';
import { ToolGroup } from './ToolGroup';
import { getToolSummary, safeJsonStringify } from '../utils/tool-summary';

// 工具使用块类型
type ToolUseBlock = ContentBlock & { type: 'tool_use' };
// 工具结果块类型
type ToolResultBlock = ContentBlock & { type: 'tool_result' };

interface ToolExecutionBatchProps {
  messages: (StreamMessage & { type: 'assistant' })[];
  toolStatusMap: Map<string, ToolStatus>;
  toolResultsMap: Map<string, ToolResultBlock>;
}

// 从 assistant 消息中提取所有 tool_use 块
function extractToolBlocks(
  messages: (StreamMessage & { type: 'assistant' })[]
): ToolUseBlock[] {
  const blocks: ToolUseBlock[] = [];
  for (const msg of messages) {
    for (const block of msg.message.content) {
      if (block.type === 'tool_use') {
        blocks.push(block as ToolUseBlock);
      }
    }
  }
  return blocks;
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
}: ToolExecutionBatchProps) {
  const [expanded, setExpanded] = useState(false);

  // 提取所有工具块
  const allBlocks = useMemo(() => extractToolBlocks(messages), [messages]);

  // 过滤掉 TodoWrite（内部状态管理工具）
  const visibleBlocks = useMemo(
    () => allBlocks.filter((b) => b.name !== 'TodoWrite'),
    [allBlocks]
  );
  const todoWriteCount = allBlocks.length - visibleBlocks.length;

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

  // 如果没有可见工具（全是 TodoWrite），显示简化版本
  if (totalTools === 0 && todoWriteCount > 0) {
    return (
      <div className="my-2 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]/50 px-3 py-2">
        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <StatusDot status={batchStatus} />
          <span>Updated todo list ({todoWriteCount} times)</span>
        </div>
      </div>
    );
  }

  return (
    <div className="my-2 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]/50 overflow-hidden">
      {/* 折叠头部 */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2 flex items-center gap-2 hover:bg-[var(--bg-tertiary)]/30 transition-colors text-left"
      >
        <ChevronIcon expanded={expanded} />
        <StatusDot status={batchStatus} />
        <span className="font-medium text-sm">Task Execution</span>
        {summary && (
          <span className="text-sm text-[var(--text-secondary)] truncate">
            {summary}
          </span>
        )}
        <div className="flex-1" />
        {/* 工具类型 badges */}
        <div className="flex gap-1.5 flex-wrap justify-end">
          {[...toolCounts.entries()].map(([name, count]) => (
            <span
              key={name}
              className="text-xs px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]"
            >
              {name} ({count})
            </span>
          ))}
          {todoWriteCount > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)] opacity-50">
              +{todoWriteCount} todo
            </span>
          )}
        </div>
      </button>

      {/* 展开内容 */}
      {expanded && (
        <div className="border-t border-[var(--border)] px-3 py-2">
          {/* 显示每个工具调用 */}
          {visibleBlocks.map((block, idx) => (
            <ToolInvocationCompact
              key={block.id}
              block={block}
              result={toolResultsMap.get(block.id)}
              status={toolStatusMap.get(block.id) || 'pending'}
              isLast={idx === visibleBlocks.length - 1}
            />
          ))}

          {/* TodoWrite 汇总 */}
          {todoWriteCount > 0 && (
            <div className="mt-2 pt-2 border-t border-[var(--border)]/50 text-xs text-[var(--text-muted)]">
              + Updated todo list ({todoWriteCount} times)
            </div>
          )}
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
  isLast,
}: {
  block: ToolUseBlock;
  result?: ToolResultBlock;
  status: ToolStatus;
  isLast: boolean;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const summary = getToolSummary(block.name, block.input);
  // 安全检查：确保 content 是字符串
  const contentStr = result?.content != null
    ? (typeof result.content === 'string' ? result.content : safeJsonStringify(result.content))
    : '';
  const hasOutput = contentStr.length > 0;

  return (
    <div className={`${isLast ? '' : 'border-b border-[var(--border)]/30'} py-1`}>
      {/* 主行 */}
      <div
        className="flex items-center gap-2 cursor-pointer hover:bg-[var(--bg-tertiary)]/20 rounded px-1 -mx-1"
        onClick={() => setShowDetails(!showDetails)}
      >
        <div className={`status-dot-sm ${status}`} />
        <span className="font-medium text-xs text-[var(--accent)]">
          {block.name}
        </span>
        <span className="text-xs text-[var(--text-secondary)] font-mono truncate flex-1">
          {summary}
        </span>
        <span className="text-xs text-[var(--text-muted)]">
          {status === 'success' ? '✓' : status === 'error' ? '✗' : '⋯'}
        </span>
      </div>

      {/* 展开详情 */}
      {showDetails && (
        <div className="ml-4 mt-1 text-xs">
          {/* 参数 */}
          <div className="mb-1">
            <span className="text-[var(--text-muted)]">Args:</span>
            <pre className="mt-0.5 p-2 bg-[var(--bg-tertiary)] rounded text-[var(--text-secondary)] whitespace-pre-wrap break-all max-h-32 overflow-auto">
              {safeJsonStringify(block.input, 2)}
            </pre>
          </div>

          {/* 输出 */}
          {hasOutput && (
            <div>
              <span className={result?.is_error ? 'text-red-400' : 'text-[var(--text-muted)]'}>
                Output:
              </span>
              <pre
                className={`mt-0.5 p-2 bg-[var(--bg-tertiary)] rounded whitespace-pre-wrap break-all max-h-32 overflow-auto ${
                  result?.is_error ? 'text-red-400' : 'text-[var(--text-secondary)]'
                }`}
              >
                {contentStr}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// 状态点组件
function StatusDot({ status }: { status: ToolStatus }) {
  const statusClass =
    status === 'pending' ? 'running' : status === 'success' ? 'completed' : 'error';
  return <div className={`status-dot ${statusClass}`} />;
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

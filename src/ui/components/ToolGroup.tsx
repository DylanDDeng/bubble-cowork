import { useState, useMemo } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ContentBlock, ToolStatus } from '../types';
import { getToolSummary, safeJsonStringify } from '../utils/tool-summary';
import { extractLatestTodoProgress } from '../utils/todo-progress';
import { TodoProgressCard } from './TodoProgressCard';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// 工具使用块类型
type ToolUseBlock = ContentBlock & { type: 'tool_use' };
// 工具结果块类型
type ToolResultBlock = ContentBlock & { type: 'tool_result' };

interface ToolGroupProps {
  toolUseBlocks: ToolUseBlock[];
  toolResults: Map<string, ToolResultBlock>;
  toolStatusMap: Map<string, ToolStatus>;
  defaultExpanded?: boolean;
  hideTodoWrite?: boolean; // 是否隐藏 TodoWrite 工具
}

// 获取工具组摘要（基于第一个工具或 Task 工具的描述）
function getGroupSummary(blocks: ToolUseBlock[]): string {
  if (blocks.length === 0) return '';

  // 查找 Task 工具，它通常有描述
  const taskBlock = blocks.find((b) => b.name === 'Task');
  if (taskBlock) {
    const summary = getToolSummary('Task', taskBlock.input);
    if (summary) return summary;
  }

  // 否则使用第一个工具的信息
  const firstBlock = blocks[0];
  return getToolSummary(firstBlock.name, firstBlock.input);
}

// 计算整体状态
function getGroupStatus(
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

// ToolGroup - 主组件（Tool Execution Trace）
export function ToolGroup({
  toolUseBlocks,
  toolResults,
  toolStatusMap,
  defaultExpanded = false,
  hideTodoWrite = true,
}: ToolGroupProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  // 过滤 TodoWrite 工具（如果启用）
  const visibleBlocks = useMemo(
    () => hideTodoWrite ? toolUseBlocks.filter((b) => b.name !== 'TodoWrite') : toolUseBlocks,
    [toolUseBlocks, hideTodoWrite]
  );
  const todoWriteCount = toolUseBlocks.length - visibleBlocks.length;
  const todoProgress = useMemo(
    () => extractLatestTodoProgress(toolUseBlocks),
    [toolUseBlocks]
  );

  const summary = useMemo(
    () => getGroupSummary(toolUseBlocks), // 用原始块获取摘要
    [toolUseBlocks]
  );
  const groupStatus = useMemo(
    () => getGroupStatus(toolUseBlocks, toolStatusMap), // 状态计算用全部
    [toolUseBlocks, toolStatusMap]
  );
  const toolCount = visibleBlocks.length;

  // 如果没有可见工具（全是 TodoWrite），显示简化版本
  if (toolCount === 0 && todoProgress) {
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
        <ChevronRight className={`w-4 h-4 text-[var(--text-muted)] flex-shrink-0 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`} />
        <span className="font-medium text-sm text-[var(--text-primary)]">Task</span>
        <span className="text-sm text-[var(--text-secondary)] truncate flex-1">
          {summary || 'Tool execution'}
        </span>
        <span className="text-xs text-[var(--text-muted)]">
          {toolCount > 0 ? `Used ${toolCount} tool${toolCount > 1 ? 's' : ''}` : ''}
          {todoWriteCount > 0 && toolCount > 0 && ' • '}
          {todoWriteCount > 0 && <span className="opacity-60">+{todoWriteCount} todo</span>}
        </span>
      </button>

      {todoProgress && (
        <div className="px-3 pb-3">
          <TodoProgressCard state={todoProgress} />
        </div>
      )}

      {/* 展开内容 - Tree 风格 */}
      {expanded && (
        <div className={`px-3 pb-2 ${todoProgress ? 'border-t border-[var(--border)]/60 pt-2' : ''}`}>
          {visibleBlocks.map((block, idx) => (
            <ToolInvocation
              key={block.id}
              block={block}
              result={toolResults.get(block.id)}
              status={toolStatusMap.get(block.id) || 'pending'}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ToolInvocation - 单个工具调用（tree 风格）
function ToolInvocation({
  block,
  result,
  status,
}: {
  block: ToolUseBlock;
  result?: ToolResultBlock;
  status: ToolStatus;
}) {
  const [showArgs, setShowArgs] = useState(false);
  const [showOutput, setShowOutput] = useState(false);

  const inputObj = isRecord(block.input) ? block.input : {};
  const hasArgs = Object.keys(inputObj).length > 0;
  // 安全检查：确保 content 是字符串
  const contentStr = result?.content != null
    ? (typeof result.content === 'string' ? result.content : safeJsonStringify(result.content))
    : '';
  const hasOutput = contentStr.length > 0;
  const outputLines = hasOutput ? contentStr.split('\n').length : 0;
  const summary = getToolSummary(block.name, block.input);

  return (
    <div className="mb-1.5 rounded-lg border border-[var(--border)]/70 bg-[var(--bg-primary)]/80 px-3 py-2">
      {/* 工具头部 */}
      <div className="flex items-center gap-2">
        <div className={`status-dot-sm ${status}`} />
        <span className="font-medium text-sm text-[var(--accent)]">{block.name}</span>
        <span className="text-xs text-[var(--text-secondary)] font-mono truncate flex-1">
          {summary}
        </span>
        <span className="text-xs text-[var(--text-muted)]">
          {status === 'success' ? '✓' : status === 'error' ? '✗' : '⋯'}
        </span>
      </div>

      {/* Arguments 折叠区 */}
      {hasArgs && (
        <CollapsibleSection
          label="Arguments"
          expanded={showArgs}
          onToggle={() => setShowArgs(!showArgs)}
        >
          <pre className="text-xs font-mono text-[var(--text-secondary)] whitespace-pre-wrap break-all">
            {safeJsonStringify(block.input, 2)}
          </pre>
        </CollapsibleSection>
      )}

      {/* Output 折叠区 */}
      {hasOutput && (
        <CollapsibleSection
          label={`Output (${outputLines} line${outputLines > 1 ? 's' : ''})`}
          expanded={showOutput}
          onToggle={() => setShowOutput(!showOutput)}
          isError={result?.is_error}
        >
          <pre
            className={`text-xs font-mono whitespace-pre-wrap break-all ${
              result?.is_error ? 'text-red-400' : 'text-[var(--text-secondary)]'
            }`}
          >
            {contentStr}
          </pre>
        </CollapsibleSection>
      )}
    </div>
  );
}

// CollapsibleSection - 可折叠区块
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
    <div className="ml-4 my-1">
      <button
        onClick={onToggle}
        className={`flex items-center gap-1 text-xs hover:text-[var(--text-secondary)] ${
          isError ? 'text-red-400/70' : 'text-[var(--text-muted)]'
        }`}
      >
        <ChevronRight className={`w-3 h-3 text-[var(--text-muted)] flex-shrink-0 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`} />
        <span>{label}</span>
      </button>
      {expanded && (
        <div className="mt-1 rounded bg-[var(--bg-tertiary)] p-2 max-h-48 overflow-auto">
          {children}
        </div>
      )}
    </div>
  );
}

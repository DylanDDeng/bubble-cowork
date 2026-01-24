import { useState, useMemo } from 'react';
import type { ContentBlock, ToolStatus } from '../types';
import { getToolSummary, safeJsonStringify } from '../utils/tool-summary';

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
  if (toolCount === 0 && todoWriteCount > 0) {
    return (
      <div className="my-2 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]/50 px-3 py-2">
        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <div className={`status-dot ${groupStatus === 'pending' ? 'running' : groupStatus === 'success' ? 'completed' : 'error'}`} />
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
        <StatusDot status={groupStatus} />
        <span className="font-medium text-sm">Task</span>
        <span className="text-sm text-[var(--text-secondary)] truncate flex-1">
          {summary || 'Tool execution'}
        </span>
        <span className="text-xs text-[var(--text-muted)]">
          {toolCount > 0 ? `Used ${toolCount} tool${toolCount > 1 ? 's' : ''}` : ''}
          {todoWriteCount > 0 && toolCount > 0 && ' • '}
          {todoWriteCount > 0 && <span className="opacity-60">+{todoWriteCount} todo</span>}
        </span>
      </button>

      {/* 展开内容 - Tree 风格 */}
      {expanded && (
        <div className="px-3 pb-2">
          {visibleBlocks.map((block, idx) => (
            <ToolInvocation
              key={block.id}
              block={block}
              result={toolResults.get(block.id)}
              status={toolStatusMap.get(block.id) || 'pending'}
              isLast={idx === visibleBlocks.length - 1 && todoWriteCount === 0}
            />
          ))}
          {/* TodoWrite 汇总 */}
          {todoWriteCount > 0 && (
            <div className="tree-item tree-item-last">
              <div className="flex items-center gap-2 py-1 text-xs text-[var(--text-muted)]">
                <div className="status-dot-sm completed" />
                <span>Updated todo list ({todoWriteCount} times)</span>
              </div>
            </div>
          )}
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
  isLast,
}: {
  block: ToolUseBlock;
  result?: ToolResultBlock;
  status: ToolStatus;
  isLast: boolean;
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
    <div className={`tree-item ${isLast ? 'tree-item-last' : ''}`}>
      {/* 工具头部 */}
      <div className="flex items-center gap-2 py-1">
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
        <ChevronIconSm expanded={expanded} />
        <span>{label}</span>
      </button>
      {expanded && (
        <div className="mt-1 p-2 bg-[var(--bg-tertiary)] rounded max-h-48 overflow-auto">
          {children}
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

// 小箭头图标
function ChevronIconSm({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`chevron-icon-sm text-[var(--text-muted)] flex-shrink-0 ${
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

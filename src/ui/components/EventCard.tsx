import { useState, useMemo } from 'react';
import type { ContentBlock, StreamMessage, ToolStatus } from '../types';
import { getToolSummary, safeJsonStringify } from '../utils/tool-summary';

interface ToolUseCardProps {
  block: ContentBlock & { type: 'tool_use' };
  status: ToolStatus;
}

interface ToolResultCardProps {
  block: ContentBlock & { type: 'tool_result' };
}

interface SystemInfoCardProps {
  message: StreamMessage & { type: 'system'; subtype: 'init' };
}

interface SessionResultCardProps {
  message: StreamMessage & { type: 'result' };
}

const MAX_VISIBLE_LINES = 3;
const MAX_CHARS_PER_LINE = 100;

// 工具调用卡片
export function ToolUseCard({ block, status }: ToolUseCardProps) {
  const summary = getToolSummary(block.name, block.input);

  return (
    <div className="bg-[var(--bg-tertiary)] rounded-lg p-3 my-2">
      <div className="flex items-center gap-2 mb-1">
        <div className={`tool-status ${status}`} />
        <span className="font-medium text-sm">{block.name}</span>
      </div>
      <div className="text-xs text-[var(--text-secondary)] font-mono truncate">
        {summary}
      </div>
    </div>
  );
}

// 工具结果卡片
export function ToolResultCard({ block }: ToolResultCardProps) {
  const [expanded, setExpanded] = useState(false);

  // 安全检查：确保 content 是字符串
  const contentStr = block.content != null
    ? (typeof block.content === 'string' ? block.content : safeJsonStringify(block.content))
    : '';
  const lines = contentStr.split('\n');
  const isLong = lines.length > MAX_VISIBLE_LINES;
  const displayContent = expanded
    ? contentStr
    : lines
        .slice(0, MAX_VISIBLE_LINES)
        .map((line) =>
          line.length > MAX_CHARS_PER_LINE
            ? line.slice(0, MAX_CHARS_PER_LINE) + '...'
            : line
        )
        .join('\n');

  return (
    <div
      className={`bg-[var(--bg-tertiary)] rounded-lg p-3 my-2 ${
        block.is_error ? 'border border-red-500/30' : ''
      }`}
    >
      <div className="flex items-center gap-2 mb-2">
        <div className={`tool-status ${block.is_error ? 'error' : 'success'}`} />
        <span className="text-xs text-[var(--text-secondary)]">
          {block.is_error ? 'Error' : 'Result'}
        </span>
      </div>

      <pre className="text-xs font-mono whitespace-pre-wrap break-all overflow-hidden">
        {displayContent}
      </pre>

      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-[var(--accent)] hover:underline mt-2"
        >
          {expanded ? 'Show less' : `Show more (${lines.length - MAX_VISIBLE_LINES} more lines)`}
        </button>
      )}
    </div>
  );
}

// 系统信息卡片
export function SystemInfoCard({ message }: SystemInfoCardProps) {
  return (
    <div className="bg-[var(--bg-tertiary)] rounded-lg p-3 my-2 text-xs">
      <div className="text-[var(--text-secondary)] mb-2">Session Started</div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <span className="text-[var(--text-muted)]">Model: </span>
          <span>{message.model}</span>
        </div>
        <div>
          <span className="text-[var(--text-muted)]">Mode: </span>
          <span>{message.permissionMode}</span>
        </div>
        <div className="col-span-2">
          <span className="text-[var(--text-muted)]">CWD: </span>
          <span className="font-mono">{message.cwd}</span>
        </div>
      </div>
    </div>
  );
}

// 会话结果卡片
export function SessionResultCard({ message }: SessionResultCardProps) {
  const isSuccess = message.subtype === 'success';

  return (
    <div
      className={`rounded-lg p-3 my-2 text-xs ${
        isSuccess
          ? 'bg-green-500/10 border border-green-500/30'
          : 'bg-red-500/10 border border-red-500/30'
      }`}
    >
      <div className="flex items-center gap-2 mb-2">
        <div className={`tool-status ${isSuccess ? 'success' : 'error'}`} />
        <span className="font-medium">
          {isSuccess ? 'Session Completed' : 'Session Failed'}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2 text-[var(--text-secondary)]">
        <div>
          <span className="text-[var(--text-muted)]">Duration: </span>
          <span>{(message.duration_ms / 1000).toFixed(1)}s</span>
        </div>
        <div>
          <span className="text-[var(--text-muted)]">Cost: </span>
          <span>${message.total_cost_usd.toFixed(4)}</span>
        </div>
        <div>
          <span className="text-[var(--text-muted)]">Tokens: </span>
          <span>
            {message.usage.input_tokens + message.usage.output_tokens}
          </span>
        </div>
      </div>
    </div>
  );
}

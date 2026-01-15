import { useEffect, useRef, useState, useMemo } from 'react';
import { useAppStore } from './store/useAppStore';
import { useIPC, sendEvent } from './hooks/useIPC';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { Sidebar } from './components/Sidebar';
import { NewSessionView } from './components/NewSessionView';
import { PromptInput } from './components/PromptInput';
import { MessageCard } from './components/MessageCard';
import { ToolExecutionBatch } from './components/ToolExecutionBatch';
import { InSessionSearch } from './components/search/InSessionSearch';
import { MDContent } from './render/markdown';
import type { ToolStatus, PermissionResult, StreamMessage, ContentBlock } from './types';

// 工具结果块类型
type ToolResultBlock = ContentBlock & { type: 'tool_result' };

// 聚合项类型
type AggregatedItem =
  | { type: 'message'; message: StreamMessage; originalIndex: number }
  | { type: 'tool_batch'; messages: (StreamMessage & { type: 'assistant' })[]; originalIndices: number[] };

// 判断消息是否包含工具调用（可以有文本内容）
function hasToolUse(msg: StreamMessage): msg is StreamMessage & { type: 'assistant' } {
  if (msg.type !== 'assistant') return false;
  const content = msg.message.content;
  // 只要包含 tool_use 就算（允许混合 text + tool_use）
  return content.some((block) => block.type === 'tool_use');
}

// 判断是否为 tool_result-only 的 user 消息（这类消息不应该打断聚合）
function isToolResultOnlyMessage(msg: StreamMessage): boolean {
  if (msg.type !== 'user') return false;
  const content = msg.message.content;
  return content.length > 0 && content.every((block) => block.type === 'tool_result');
}

// 聚合连续的工具执行消息
function aggregateMessages(messages: StreamMessage[]): AggregatedItem[] {
  const items: AggregatedItem[] = [];
  let currentBatch: { msg: StreamMessage; index: number }[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (hasToolUse(msg) || isToolResultOnlyMessage(msg)) {
      // 包含 tool_use 的 assistant 或 tool_result-only 的 user，加入批次
      currentBatch.push({ msg, index: i });
    } else {
      // 遇到非工具消息，先结束当前批次
      const assistantItems = currentBatch.filter(
        (item): item is { msg: StreamMessage & { type: 'assistant' }; index: number } =>
          item.msg.type === 'assistant'
      );
      if (assistantItems.length >= 3) {
        // 3个以上才聚合
        items.push({
          type: 'tool_batch',
          messages: assistantItems.map((item) => item.msg),
          originalIndices: assistantItems.map((item) => item.index),
        });
      } else {
        // 批次太小，单独显示
        currentBatch.forEach((item) =>
          items.push({ type: 'message', message: item.msg, originalIndex: item.index })
        );
      }
      currentBatch = [];
      items.push({ type: 'message', message: msg, originalIndex: i });
    }
  }

  // 处理末尾的批次
  const assistantItems = currentBatch.filter(
    (item): item is { msg: StreamMessage & { type: 'assistant' }; index: number } =>
      item.msg.type === 'assistant'
  );
  if (assistantItems.length >= 3) {
    items.push({
      type: 'tool_batch',
      messages: assistantItems.map((item) => item.msg),
      originalIndices: assistantItems.map((item) => item.index),
    });
  } else {
    currentBatch.forEach((item) =>
      items.push({ type: 'message', message: item.msg, originalIndex: item.index })
    );
  }

  return items;
}

export function App() {
  // 初始化 IPC 通信
  useIPC();

  // 初始化全局快捷键
  useKeyboardShortcuts();

  const {
    connected,
    sessions,
    activeSessionId,
    showNewSession,
    globalError,
    clearGlobalError,
    removePermissionRequest,
  } = useAppStore();

  // 历史请求记录（防止重复请求）
  const historyRequested = useRef(new Set<string>());

  // Partial streaming 状态
  const [partialMessage, setPartialMessage] = useState('');
  const [showPartialMessage, setShowPartialMessage] = useState(false);
  const partialMessageRef = useRef('');

  // 消息列表引用（用于滚动）
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // 工具状态映射和结果映射
  const { toolStatusMap, toolResultsMap } = useMemo(() => {
    const statusMap = new Map<string, ToolStatus>();
    const resultsMap = new Map<string, ToolResultBlock>();
    const session = activeSessionId ? sessions[activeSessionId] : null;
    if (!session) return { toolStatusMap: statusMap, toolResultsMap: resultsMap };

    for (const msg of session.messages) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            statusMap.set(block.id, 'pending');
          }
        }
      } else if (msg.type === 'user') {
        for (const block of msg.message.content) {
          if (block.type === 'tool_result') {
            statusMap.set(block.tool_use_id, block.is_error ? 'error' : 'success');
            resultsMap.set(block.tool_use_id, block as ToolResultBlock);
          }
        }
      }
    }

    return { toolStatusMap: statusMap, toolResultsMap: resultsMap };
  }, [activeSessionId, sessions]);

  // 连接后请求会话列表
  useEffect(() => {
    if (connected) {
      sendEvent({ type: 'session.list' });
    }
  }, [connected]);

  // 切换会话时请求历史
  useEffect(() => {
    if (!activeSessionId) return;

    const session = sessions[activeSessionId];
    if (!session) return;

    // 如果会话未 hydrated 且未请求过，则请求历史
    if (!session.hydrated && !historyRequested.current.has(activeSessionId)) {
      historyRequested.current.add(activeSessionId);
      sendEvent({
        type: 'session.history',
        payload: { sessionId: activeSessionId },
      });
    }
  }, [activeSessionId, sessions]);

  // 处理 stream_event（partial streaming）
  useEffect(() => {
    const session = activeSessionId ? sessions[activeSessionId] : null;
    if (!session) return;

    const lastMessage = session.messages[session.messages.length - 1];
    if (!lastMessage || lastMessage.type !== 'stream_event') return;

    const event = (lastMessage as StreamMessage & { type: 'stream_event' }).event;

    switch (event.type) {
      case 'content_block_start':
        partialMessageRef.current = '';
        setPartialMessage('');
        setShowPartialMessage(true);
        break;

      case 'content_block_delta':
        if (event.delta) {
          const deltaType = event.delta.type;
          // text_delta -> text, thinking_delta -> thinking
          const prefix = deltaType.replace('_delta', '');
          const content = (event.delta as Record<string, string>)[prefix] || '';
          partialMessageRef.current += content;
          setPartialMessage(partialMessageRef.current);
        }
        break;

      case 'content_block_stop':
        setShowPartialMessage(false);
        partialMessageRef.current = '';
        setPartialMessage('');
        break;
    }
  }, [activeSessionId, sessions]);

  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeSessionId, sessions, partialMessage]);

  // 处理权限响应
  const handlePermissionResult = (toolUseId: string, result: PermissionResult) => {
    if (!activeSessionId) return;

    sendEvent({
      type: 'permission.response',
      payload: {
        sessionId: activeSessionId,
        toolUseId,
        result,
      },
    });

    removePermissionRequest(activeSessionId, toolUseId);
  };

  const activeSession = activeSessionId ? sessions[activeSessionId] : null;

  return (
    <div className="flex h-full">
      {/* 侧边栏 */}
      <Sidebar />

      {/* 主内容区 */}
      {activeSession && !showNewSession ? (
        <div className="flex-1 flex flex-col">
          {/* 顶部拖拽区域 */}
          <div className="h-8 drag-region flex-shrink-0" />

          {/* 消息区域 */}
          <div className="flex-1 overflow-auto p-4 relative">
            {/* 会话内搜索 */}
            <InSessionSearch />

            {/* CWD 显示栏 - 右上角 */}
            {activeSession.cwd && (
              <div className="flex justify-end mb-2">
                <div className="text-xs text-[var(--text-muted)] font-mono flex items-center gap-1">
                  <span>{shortenPath(activeSession.cwd)}</span>
                  <CopyButton text={activeSession.cwd} />
                </div>
              </div>
            )}

            {/* 居中容器 */}
            <div className="max-w-4xl mx-auto">
              {/* 渲染消息（聚合连续的工具执行） */}
              {aggregateMessages(activeSession.messages).map((item, idx) => {
                if (item.type === 'tool_batch') {
                  return (
                    <div
                      key={`batch-${idx}`}
                      data-message-index={item.originalIndices[0]}
                    >
                      <ToolExecutionBatch
                        messages={item.messages}
                        toolStatusMap={toolStatusMap}
                        toolResultsMap={toolResultsMap}
                      />
                    </div>
                  );
                }
                return (
                  <div key={idx} data-message-index={item.originalIndex}>
                    <MessageCard
                      message={item.message}
                      toolStatusMap={toolStatusMap}
                      toolResultsMap={toolResultsMap}
                      permissionRequests={activeSession.permissionRequests}
                      onPermissionResult={handlePermissionResult}
                    />
                  </div>
                );
              })}

              {/* Partial streaming 显示 */}
              {showPartialMessage && (
                <div className="my-3">
                  <div className="bg-[var(--bg-secondary)] rounded-lg p-4">
                    {partialMessage ? (
                      <MDContent content={partialMessage} />
                    ) : (
                      <div className="shimmer h-4 w-32 rounded" />
                    )}
                  </div>
                </div>
              )}

              {/* 运行中指示器 */}
              {activeSession.status === 'running' && !showPartialMessage && (
                <div className="my-3 flex items-center gap-2 text-[var(--text-secondary)]">
                  <div className="status-dot running" />
                  <span className="text-sm">Processing...</span>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          </div>

          {/* 输入区域 */}
          <PromptInput />
        </div>
      ) : (
        <NewSessionView />
      )}

      {/* 全局错误提示 */}
      {globalError && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 bg-red-500/90 text-white px-4 py-2 rounded-lg shadow-lg flex items-center gap-3 max-w-md">
          <span className="text-sm flex-1">{globalError}</span>
          <button
            onClick={clearGlobalError}
            className="text-white/80 hover:text-white"
          >
            <CloseIcon />
          </button>
        </div>
      )}
    </div>
  );
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

// 简化路径显示
function shortenPath(path: string): string {
  // /Users/xxx/Documents/My Project → ~/.../My Project
  const home = '/Users/';
  if (path.startsWith(home)) {
    const parts = path.slice(home.length).split('/');
    if (parts.length > 2) {
      // 取最后两级目录
      return `~/.../${parts.slice(-2).join('/')}`;
    }
    return `~/${parts.join('/')}`;
  }
  return path;
}

// 复制按钮组件
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 复制失败
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="p-1 rounded hover:bg-[var(--bg-tertiary)] transition-colors"
      title="Copy full path"
    >
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}

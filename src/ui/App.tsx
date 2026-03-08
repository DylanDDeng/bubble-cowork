import { useEffect, useRef, useMemo, useState } from 'react';
import { Toaster, toast } from 'sonner';
import { PanelLeft, Copy, Check } from 'lucide-react';
import { useAppStore } from './store/useAppStore';
import { useIPC, sendEvent } from './hooks/useIPC';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { Sidebar } from './components/Sidebar';
import { NewSessionView } from './components/NewSessionView';
import { PromptInput } from './components/PromptInput';
import { MessageCard } from './components/MessageCard';
import { ToolExecutionBatch } from './components/ToolExecutionBatch';
import { InSessionSearch } from './components/search/InSessionSearch';
import { Settings } from './components/settings/Settings';
import { ProjectTreePanel } from './components/ProjectTreePanel';
import { ThinkingIndicator } from './components/ThinkingIndicator';
import { ErrorBoundary } from './components/ErrorBoundary';
import { MDContent } from './render/markdown';
import { getMessageContentBlocks } from './utils/message-content';
import {
  deriveTurnPhase,
  shouldShowThinkingIndicator,
  hasRunningToolInMessages,
} from './utils/turn-utils';
import type { ToolStatus, PermissionResult, StreamMessage, ContentBlock } from './types';

// 工具结果块类型
type ToolResultBlock = ContentBlock & { type: 'tool_result' };

// 聚合项类型
type AggregatedItem =
  | { type: 'message'; message: StreamMessage; originalIndex: number }
  | { type: 'tool_batch'; messages: (StreamMessage & { type: 'assistant' })[]; originalIndices: number[] };

// 判断消息是否包含可折叠的执行痕迹（thinking / tool_use）
function hasTraceAssistantContent(
  msg: StreamMessage
): msg is StreamMessage & { type: 'assistant' } {
  if (msg.type !== 'assistant') return false;
  const content = getMessageContentBlocks(msg);
  if (content.length === 0) return false;
  return content.some((block) => block.type === 'thinking' || block.type === 'tool_use');
}

// 判断是否为 tool_result-only 的 user 消息（这类消息不应该打断聚合）
function isToolResultOnlyMessage(msg: StreamMessage): boolean {
  if (msg.type !== 'user') return false;
  const content = getMessageContentBlocks(msg);
  return content.length > 0 && content.every((block) => block.type === 'tool_result');
}

function pushSegment(
  items: AggregatedItem[],
  segment: Array<{ message: StreamMessage; index: number }>
) {
  if (segment.length === 0) return;

  const lastTraceIndex = segment.reduce((lastIndex, entry, index) => {
    if (hasTraceAssistantContent(entry.message) || isToolResultOnlyMessage(entry.message)) {
      return index;
    }
    return lastIndex;
  }, -1);

  if (lastTraceIndex === -1) {
    segment.forEach((entry) =>
      items.push({ type: 'message', message: entry.message, originalIndex: entry.index })
    );
    return;
  }

  const traceAssistantEntries = segment
    .slice(0, lastTraceIndex + 1)
    .filter(
      (
        entry
      ): entry is {
        message: StreamMessage & { type: 'assistant' };
        index: number;
      } => entry.message.type === 'assistant'
    );

  if (traceAssistantEntries.length > 0) {
    items.push({
      type: 'tool_batch',
      messages: traceAssistantEntries.map((entry) => entry.message),
      originalIndices: traceAssistantEntries.map((entry) => entry.index),
    });
  }

  segment.slice(lastTraceIndex + 1).forEach((entry) =>
    items.push({ type: 'message', message: entry.message, originalIndex: entry.index })
  );
}

// 按 turn 聚合执行过程：把最终回答之前的 thinking / tool / 中间说明文字收进一个面板
function aggregateMessages(messages: StreamMessage[]): AggregatedItem[] {
  const items: AggregatedItem[] = [];
  let currentSegment: Array<{ message: StreamMessage; index: number }> = [];

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];

    if (message.type === 'user_prompt') {
      pushSegment(items, currentSegment);
      currentSegment = [];
      items.push({ type: 'message', message, originalIndex: i });
      continue;
    }

    currentSegment.push({ message, index: i });
  }

  pushSegment(items, currentSegment);

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
    showSettings,
    sidebarCollapsed,
    setSidebarCollapsed,
    projectTreeCollapsed,
    setProjectTreeCollapsed,
    globalError,
    clearGlobalError,
    removePermissionRequest,
  } = useAppStore();

  // 历史请求记录（防止重复请求）
  const historyRequested = useRef(new Set<string>());

  // 流式状态：通过 useMemo 从 session.messages 派生，实现打字机效果
  const { partialMessage, partialThinking, isStreaming: showPartialMessage } = useMemo(() => {
    const session = activeSessionId ? sessions[activeSessionId] : null;
    if (!session) return { partialMessage: '', partialThinking: '', isStreaming: false };

    const messages = session.messages;
    let text = '';
    let thinking = '';
    let streaming = false;

    // 从后往前找最后一个 content_block_start 或正在进行的流
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];

      // 遇到完整消息就停止搜索（说明没有进行中的流）
      if (msg.type === 'assistant' || msg.type === 'result') {
        break;
      }

      // 找到 content_block_start，从这里开始累积
      if (msg.type === 'stream_event' && msg.event.type === 'content_block_start') {
        streaming = true;
        // 从 start 位置往后累积所有 delta
        for (let j = i; j < messages.length; j++) {
          const m = messages[j];
          if (m.type === 'stream_event') {
            const event = m.event;
            if (event.type === 'content_block_delta' && event.delta) {
              const deltaType = event.delta.type;
              if (deltaType === 'text_delta') {
                text += typeof event.delta.text === 'string' ? event.delta.text : '';
              } else if (deltaType === 'thinking_delta') {
                thinking += typeof event.delta.thinking === 'string' ? event.delta.thinking : '';
              } else {
                // 处理其他类型的 delta
                const prefix = deltaType.replace('_delta', '');
                const rawContent = (event.delta as Record<string, unknown>)[prefix];
                const content = typeof rawContent === 'string' ? rawContent : '';
                if (prefix === 'thinking') {
                  thinking += content;
                } else {
                  text += content;
                }
              }
            } else if (event.type === 'content_block_stop') {
              // 遇到 stop，流结束
              streaming = false;
              text = '';
              thinking = '';
            }
          } else if (m.type === 'assistant' || m.type === 'result') {
            // 安全兜底：若未收到 stop，收到最终消息也结束流式
            streaming = false;
            text = '';
            thinking = '';
          }
        }
        break;
      }
    }

    return { partialMessage: text, partialThinking: thinking, isStreaming: streaming };
  }, [activeSessionId, sessions]);

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
        for (const block of getMessageContentBlocks(msg)) {
          if (block.type === 'tool_use') {
            statusMap.set(block.id, 'pending');
          }
        }
      } else if (msg.type === 'user') {
        for (const block of getMessageContentBlocks(msg)) {
          if (block.type === 'tool_result') {
            statusMap.set(block.tool_use_id, block.is_error ? 'error' : 'success');
            resultsMap.set(block.tool_use_id, block as ToolResultBlock);
          }
        }
      }
    }

    return { toolStatusMap: statusMap, toolResultsMap: resultsMap };
  }, [activeSessionId, sessions]);

  // 计算当前 Turn 阶段
  const turnPhase = useMemo(() => {
    const session = activeSessionId ? sessions[activeSessionId] : null;
    if (!session) return 'complete' as const;

    const isRunning = session.status === 'running';
    const hasRunningTool = hasRunningToolInMessages(session.messages, toolStatusMap);
    const isStreaming = showPartialMessage;

    return deriveTurnPhase(session.messages, isRunning, hasRunningTool, isStreaming);
  }, [activeSessionId, sessions, toolStatusMap, showPartialMessage]);

  // 连接后请求会话列表和 MCP 配置
  useEffect(() => {
    if (connected) {
      sendEvent({ type: 'session.list' });
      sendEvent({ type: 'mcp.get-config' });
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

  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeSessionId, sessions, partialMessage, partialThinking]);

  // 全局错误通知
  useEffect(() => {
    if (globalError) {
      toast.error(globalError, {
        duration: 5000,
        onDismiss: clearGlobalError,
        onAutoClose: clearGlobalError,
      });
    }
  }, [globalError, clearGlobalError]);

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
  const hasPendingPermissionRequests =
    (activeSession?.permissionRequests?.length ?? 0) > 0;
  const lastUserPromptIndex = useMemo(() => {
    if (!activeSession) return -1;
    for (let i = activeSession.messages.length - 1; i >= 0; i--) {
      if (activeSession.messages[i]?.type === 'user_prompt') {
        return i;
      }
    }
    return -1;
  }, [activeSession?.messages]);

  const isMacOS = useMemo(() => {
    try {
      return typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
    } catch {
      return false;
    }
  }, []);

  return (
    <div className="flex h-full">
      {/* Sidebar toggle */}
      {!showSettings && (
        <button
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          className={`fixed z-50 no-drag cursor-pointer w-8 h-8 flex items-center justify-center rounded-lg border border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--text-primary)]/5 hover:border-[var(--text-primary)]/10 transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)] ${
            isMacOS ? 'top-[8px] left-[92px]' : 'top-3 left-3'
          }`}
          title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
          aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
        >
          <SidebarToggleIcon />
        </button>
      )}

      {!showSettings && (
        <button
          onClick={() => setProjectTreeCollapsed(!projectTreeCollapsed)}
          className={`fixed z-50 no-drag cursor-pointer w-8 h-8 flex items-center justify-center rounded-lg border border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--text-primary)]/5 hover:border-[var(--text-primary)]/10 transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)] ${
            isMacOS ? 'top-[8px] right-[16px]' : 'top-3 right-3'
          }`}
          title={projectTreeCollapsed ? 'Show project files' : 'Hide project files'}
          aria-label={projectTreeCollapsed ? 'Show project files' : 'Hide project files'}
        >
          <SidebarToggleIcon />
        </button>
      )}

      {/* 侧边栏 */}
      {!showSettings && !sidebarCollapsed && <Sidebar />}

      {/* 主内容区 */}
      {showSettings ? (
        <div className="flex-1 min-w-0 flex flex-col bg-[var(--bg-primary)]">
          <div className="h-8 drag-region flex-shrink-0" />
          <div className="flex-1 min-h-0">
            <Settings />
          </div>
        </div>
      ) : activeSession && !showNewSession ? (
        <div
          className="flex-1 min-w-0 flex flex-col transition-[padding] duration-200"
          style={{ paddingRight: 'var(--project-preview-space, 0px)' }}
        >
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
            <div className="message-container">
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
                        isSessionRunning={activeSession.status === 'running'}
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
                      userPromptActions={
                        item.message.type === 'user_prompt'
                          ? {
                              canEditAndRetry: item.originalIndex === lastUserPromptIndex,
                              isSessionRunning: activeSession.status === 'running',
                              onResend: (prompt: string, attachments) => {
                                if (!activeSessionId) return;
                                if (!prompt.trim()) return;
                                if (activeSession.status === 'running') return;

                                sendEvent({
                                  type: 'session.editLatestPrompt',
                                  payload: {
                                    sessionId: activeSessionId,
                                    prompt: prompt.trim(),
                                    attachments: attachments && attachments.length > 0 ? attachments : undefined,
                                    provider: activeSession.provider,
                                    model: activeSession.model,
                                  },
                                });
                              },
                            }
                          : undefined
                      }
                    />
                  </div>
                );
              })}

              {/* Partial streaming 显示 */}
              {showPartialMessage && (partialMessage || partialThinking) && (
                <div className="my-3 min-w-0 overflow-x-auto streaming-content">
                  {partialThinking && (
                    <div className="mb-3 bg-[var(--bg-tertiary)] rounded-lg p-4 border-l-2 border-purple-500/50">
                      <div className="text-xs text-[var(--text-muted)] mb-2">Thinking...</div>
                      <div className="text-sm text-[var(--text-secondary)] whitespace-pre-wrap">
                        {partialThinking}
                      </div>
                    </div>
                  )}
                  {partialMessage && (
                    <ErrorBoundary
                      resetKey={partialMessage}
                      fallback={
                        <div className="p-3 bg-gray-800 rounded-lg">
                          <pre className="text-sm text-gray-300 whitespace-pre-wrap break-words">
                            {partialMessage}
                          </pre>
                        </div>
                      }
                    >
                      <MDContent content={partialMessage} />
                    </ErrorBoundary>
                  )}
                </div>
              )}

              {/* Thinking/Preparing 指示器 */}
              {!hasPendingPermissionRequests &&
                shouldShowThinkingIndicator(turnPhase, false) && (
                <ThinkingIndicator phase={turnPhase} isBuffering={false} />
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

      {/* 右侧项目文件树 */}
      {!showSettings && !projectTreeCollapsed && <ProjectTreePanel />}

      {/* Toast 通知 */}
      <Toaster
        position="bottom-center"
        toastOptions={{
          style: {
            background: 'var(--bg-secondary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
          },
        }}
      />

    </div>
  );
}

function SidebarToggleIcon() {
  return <PanelLeft className="w-5 h-5 pointer-events-none" aria-hidden="true" />;
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
        <Check className="w-3.5 h-3.5" />
      ) : (
        <Copy className="w-3.5 h-3.5" />
      )}
    </button>
  );
}

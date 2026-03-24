import { useEffect, useRef, useMemo, useState } from 'react';
import { Toaster, toast } from 'sonner';
import { AnimatePresence, motion } from 'motion/react';
import {
  Check,
  Copy,
  FileDiff,
  Files,
  FolderOpen,
} from 'lucide-react';
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
import { SkillMarketSettingsContent } from './components/settings/SkillMarketSettings';
import { ProjectTreePanel } from './components/ProjectTreePanel';
import { ThinkingIndicator } from './components/ThinkingIndicator';
import { ThinkingBlock } from './components/ThinkingBlock';
import { DecisionPanel } from './components/DecisionPanel';
import { ExternalFilePermissionDialog } from './components/ExternalFilePermissionDialog';
import { ErrorBoundary } from './components/ErrorBoundary';
import { applyFontPreferences } from './theme/fonts';
import { applyThemePreferences } from './theme/themes';
import { MDContent } from './render/markdown';
import { getMessageContentBlocks } from './utils/message-content';
import {
  deriveTurnPhase,
  shouldShowThinkingIndicator,
  hasRunningToolInMessages,
} from './utils/turn-utils';
import type {
  AskUserQuestionInput,
  ExternalFilePermissionInput,
  ToolStatus,
  PermissionResult,
  StreamMessage,
  ContentBlock,
} from './types';

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

    if (message.type === 'stream_event') {
      continue;
    }

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

function isExternalFilePermissionInput(input: unknown): input is ExternalFilePermissionInput {
  return (
    typeof input === 'object' &&
    input !== null &&
    'kind' in input &&
    (input as { kind?: unknown }).kind === 'external-file-access'
  );
}

function isAskUserQuestionInput(input: unknown): input is AskUserQuestionInput {
  return (
    typeof input === 'object' &&
    input !== null &&
    'questions' in input &&
    Array.isArray((input as { questions?: unknown }).questions)
  );
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
    activeWorkspace,
    showNewSession,
    showSettings,
    sidebarCollapsed,
    setSidebarCollapsed,
    projectTreeCollapsed,
    setProjectTreeCollapsed,
    globalError,
    clearGlobalError,
    removePermissionRequest,
    theme,
    colorThemeId,
    customThemeCss,
    fontSelections,
    importedFonts,
    setFontSettings,
    setSystemFonts,
  } = useAppStore();

  // 历史请求记录（防止重复请求）
  const historyRequested = useRef(new Set<string>());
  const activeSession = activeSessionId ? sessions[activeSessionId] : null;
  const [projectPanelView, setProjectPanelView] = useState<'files' | 'changes'>('files');
  const [projectChangeCount, setProjectChangeCount] = useState(0);

  const { partialMessage, partialThinking, isStreaming: showPartialMessage } = useMemo(() => {
    if (!activeSession) {
      return { partialMessage: '', partialThinking: '', isStreaming: false };
    }

    return {
      partialMessage: activeSession.streaming.text,
      partialThinking: activeSession.streaming.thinking,
      isStreaming: activeSession.streaming.isStreaming,
    };
  }, [
    activeSession?.streaming.text,
    activeSession?.streaming.thinking,
    activeSession?.streaming.isStreaming,
  ]);

  // 消息列表引用（用于滚动）
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // 工具状态映射和结果映射
  const { toolStatusMap, toolResultsMap } = useMemo(() => {
    const statusMap = new Map<string, ToolStatus>();
    const resultsMap = new Map<string, ToolResultBlock>();
    if (!activeSession) return { toolStatusMap: statusMap, toolResultsMap: resultsMap };

    for (const msg of activeSession.messages) {
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
  }, [activeSession?.messages]);

  // 计算当前 Turn 阶段
  const turnPhase = useMemo(() => {
    if (!activeSession) return 'complete' as const;

    const isRunning = activeSession.status === 'running';
    const hasRunningTool = hasRunningToolInMessages(activeSession.messages, toolStatusMap);
    const isStreaming = showPartialMessage;

    return deriveTurnPhase(activeSession.messages, isRunning, hasRunningTool, isStreaming);
  }, [activeSession?.messages, activeSession?.status, toolStatusMap, showPartialMessage]);
  const aggregatedMessages = useMemo(
    () => (activeSession ? aggregateMessages(activeSession.messages) : []),
    [activeSession?.messages]
  );

  // 连接后请求会话列表和 MCP 配置
  useEffect(() => {
    if (connected) {
      sendEvent({ type: 'session.list' });
      sendEvent({ type: 'mcp.get-config' });
    }
  }, [connected]);

  useEffect(() => {
    if (sidebarCollapsed) {
      setSidebarCollapsed(false);
    }
  }, [sidebarCollapsed, setSidebarCollapsed]);

  useEffect(() => {
    applyThemePreferences({
      themeMode: theme,
      colorThemeId,
      customThemeCss,
    });
    applyFontPreferences({
      fontSelections,
      importedFonts,
    });
  }, [colorThemeId, customThemeCss, fontSelections, importedFonts, theme]);

  useEffect(() => {
    let cancelled = false;

    window.electron
      .getFontSettings()
      .then((settings) => {
        if (!cancelled) {
          setFontSettings(settings);
        }
      })
      .catch((error) => {
        console.error('Failed to load font settings:', error);
      });

    window.electron
      .listSystemFonts()
      .then((fonts) => {
        if (!cancelled) {
          setSystemFonts(fonts);
        }
      })
      .catch((error) => {
        console.error('Failed to list system fonts:', error);
        if (!cancelled) {
          setSystemFonts([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [setFontSettings, setSystemFonts]);

  // 切换会话时请求历史
  useEffect(() => {
    if (!activeSessionId) return;

    if (!activeSession) return;

    // 如果会话未 hydrated 且未请求过，则请求历史
    if (!activeSession.hydrated && !historyRequested.current.has(activeSessionId)) {
      historyRequested.current.add(activeSessionId);
      sendEvent({
        type: 'session.history',
        payload: { sessionId: activeSessionId },
      });
    }
  }, [activeSessionId, activeSession]);

  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: showPartialMessage ? 'auto' : 'smooth' });
  }, [
    activeSessionId,
    activeSession?.messages.length,
    activeSession?.streaming.isStreaming,
    partialMessage,
    partialThinking,
    showPartialMessage,
  ]);

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

  const hasPendingPermissionRequests =
    (activeSession?.permissionRequests?.length ?? 0) > 0;
  const activeExternalPermissionRequest = useMemo(
    () => activeSession?.permissionRequests.find((request) => isExternalFilePermissionInput(request.input)) || null,
    [activeSession?.permissionRequests]
  );
  const activeGenericPermissionRequest = useMemo(
    () =>
      activeSession?.provider !== 'claude'
        ? activeSession?.permissionRequests.find((request) => isAskUserQuestionInput(request.input)) || null
        : null,
    [activeSession?.permissionRequests, activeSession?.provider]
  );
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
      {!showSettings && activeWorkspace === 'chat' && projectTreeCollapsed && (
        <FloatingProjectPanelDock
          className={isMacOS ? 'right-[14px] top-[56px]' : 'right-4 top-1/2 -translate-y-1/2'}
          changeCount={projectChangeCount}
          onOpen={(view) => {
            setProjectPanelView(view);
            setProjectTreeCollapsed(false);
          }}
        />
      )}

      {/* 侧边栏 */}
      {!showSettings && <Sidebar />}

      {/* 主内容区 */}
      {showSettings ? (
        <div className="flex-1 min-w-0 flex flex-col bg-[var(--bg-primary)]">
          <div className="flex-1 min-h-0">
            <Settings />
          </div>
        </div>
      ) : activeWorkspace === 'skills' ? (
        <div className="flex-1 min-w-0 flex flex-col bg-[var(--bg-primary)]">
          <div className="h-8 drag-region flex-shrink-0" />
          <main className="min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-[1360px] px-8 py-8">
              <SkillMarketSettingsContent />
            </div>
          </main>
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

            {/* CWD 显示栏 */}
            {activeSession.cwd && (
              <div className="mb-4 flex justify-center">
                <div
                  className="inline-flex max-w-[560px] items-center gap-1.5 text-xs text-[var(--text-muted)]"
                  title={activeSession.cwd}
                >
                  <span className="flex h-4.5 w-4.5 shrink-0 items-center justify-center text-[var(--tree-file-accent-fg)]">
                    <FolderOpen className="h-3.5 w-3.5" />
                  </span>
                  <span className="truncate font-mono">.../{getPathLeaf(activeSession.cwd)}</span>
                  <CopyButton text={activeSession.cwd} />
                </div>
              </div>
            )}

            {/* 居中容器 */}
            <div className="message-container">
              {/* 渲染消息（聚合连续的工具执行） */}
              {aggregatedMessages.map((item, idx) => {
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
                                    compatibleProviderId: activeSession.compatibleProviderId,
                                    betas: activeSession.betas,
                                    claudeAccessMode:
                                      activeSession.provider === 'claude'
                                        ? activeSession.claudeAccessMode || 'default'
                                        : undefined,
                                    codexPermissionMode:
                                      activeSession.provider === 'codex'
                                        ? activeSession.codexPermissionMode || 'defaultPermissions'
                                        : undefined,
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
                    <div className="mb-3">
                      <ThinkingBlock content={partialThinking} title="Thinking..." defaultExpanded />
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
          <div className="px-8 pb-4">
            <PromptInput />
          </div>
        </div>
      ) : (
        <NewSessionView />
      )}

      {/* 右侧项目文件树 */}
      {!showSettings && activeWorkspace === 'chat' && (
        <ProjectTreePanel
          collapsed={projectTreeCollapsed}
          activeTab={projectPanelView}
          onChangeTab={setProjectPanelView}
          onClose={() => setProjectTreeCollapsed(true)}
          onChangeCountChange={setProjectChangeCount}
        />
      )}

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

      {activeExternalPermissionRequest && isExternalFilePermissionInput(activeExternalPermissionRequest.input) && (
        <ExternalFilePermissionDialog
          input={activeExternalPermissionRequest.input}
          onSubmit={(result) =>
            handlePermissionResult(activeExternalPermissionRequest.toolUseId, result)
          }
        />
      )}

      {activeGenericPermissionRequest && isAskUserQuestionInput(activeGenericPermissionRequest.input) && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/18 px-4 backdrop-blur-[1px]">
          <div className="w-full max-w-2xl rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)] p-5 shadow-2xl">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
              Permission Request
            </div>
            <div className="mt-2 text-lg font-semibold text-[var(--text-primary)]">
              {activeGenericPermissionRequest.toolName}
            </div>
            <div className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
              The agent needs your approval before continuing.
            </div>
            <DecisionPanel
              input={activeGenericPermissionRequest.input}
              onSubmit={(result) =>
                handlePermissionResult(activeGenericPermissionRequest.toolUseId, result)
              }
            />
          </div>
        </div>
      )}

    </div>
  );
}

function FloatingProjectPanelDock({
  onOpen,
  className,
  changeCount,
}: {
  onOpen: (view: 'files' | 'changes') => void;
  className: string;
  changeCount: number;
}) {
  const items = [
    {
      id: 'files' as const,
      label: 'Files',
      icon: Files,
    },
    {
      id: 'changes' as const,
      label: 'Changes',
      icon: FileDiff,
    },
  ];

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, x: 12, scale: 0.92 }}
        animate={{ opacity: 1, x: 0, scale: 1 }}
        exit={{ opacity: 0, x: 12, scale: 0.92 }}
        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
        className={`fixed z-50 no-drag ${className}`}
      >
        <div className="flex flex-col gap-1 rounded-[12px] border border-[var(--border)] bg-[var(--bg-secondary)]/92 p-1 shadow-[0_10px_22px_rgba(15,23,42,0.10)] backdrop-blur-md">
          {items.map((item) => {
            const Icon = item.icon;

            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onOpen(item.id)}
                title={item.label}
                aria-label={`Open ${item.label} panel`}
                className="relative flex h-8 w-8 items-center justify-center rounded-[9px] border border-transparent bg-transparent text-[var(--text-secondary)] transition-[background-color,border-color,color,transform,box-shadow] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] hover:scale-[1.01] hover:border-[var(--border)] hover:bg-[var(--bg-primary)] hover:text-[var(--text-primary)]"
              >
                <Icon className="h-[14px] w-[14px]" aria-hidden="true" />
                {item.id === 'changes' && changeCount > 0 ? (
                  <span className="absolute -right-1 -top-1 min-w-[16px] rounded-full bg-[var(--accent)] px-1 text-center text-[10px] font-semibold leading-4 text-[var(--accent-foreground)] shadow-[0_4px_10px_rgba(15,23,42,0.16)]">
                    {changeCount > 99 ? '99+' : changeCount}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

function getPathLeaf(path: string): string {
  const segments = path.split(/[\\/]+/).filter(Boolean);
  return segments.at(-1) || path;
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

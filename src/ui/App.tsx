import { useEffect, useRef, useState, useMemo } from 'react';
import { useAppStore } from './store/useAppStore';
import { useIPC, sendEvent } from './hooks/useIPC';
import { Sidebar } from './components/Sidebar';
import { StartSessionModal } from './components/StartSessionModal';
import { PromptInput } from './components/PromptInput';
import { MessageCard } from './components/MessageCard';
import { MDContent } from './render/markdown';
import type { ToolStatus, PermissionResult, StreamMessage } from './types';

export function App() {
  // 初始化 IPC 通信
  useIPC();

  const {
    connected,
    sessions,
    activeSessionId,
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

  // 工具状态映射
  const toolStatusMap = useMemo(() => {
    const map = new Map<string, ToolStatus>();
    const session = activeSessionId ? sessions[activeSessionId] : null;
    if (!session) return map;

    for (const msg of session.messages) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            map.set(block.id, 'pending');
          }
        }
      } else if (msg.type === 'user') {
        for (const block of msg.message.content) {
          if (block.type === 'tool_result') {
            map.set(block.tool_use_id, block.is_error ? 'error' : 'success');
          }
        }
      }
    }

    return map;
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
      <div className="flex-1 flex flex-col">
        {/* 顶部拖拽区域 */}
        <div className="h-8 drag-region flex-shrink-0" />

        {/* 消息区域 */}
        <div className="flex-1 overflow-y-auto p-4">
          {activeSession ? (
            <>
              {/* 渲染消息 */}
              {activeSession.messages.map((message, idx) => (
                <MessageCard
                  key={idx}
                  message={message}
                  toolStatusMap={toolStatusMap}
                  permissionRequests={activeSession.permissionRequests}
                  onPermissionResult={handlePermissionResult}
                />
              ))}

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
            </>
          ) : (
            <div className="flex items-center justify-center h-full text-[var(--text-muted)]">
              <div className="text-center">
                <div className="text-4xl mb-4">Claude Cowork</div>
                <div className="text-sm">Select a session or start a new one</div>
              </div>
            </div>
          )}
        </div>

        {/* 输入区域 */}
        <PromptInput />
      </div>

      {/* 新建会话弹窗 */}
      <StartSessionModal />

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

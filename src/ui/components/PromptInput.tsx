import { useState, useRef, useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';
import { sendEvent } from '../hooks/useIPC';

export function PromptInput() {
  const { activeSessionId, sessions, setShowNewSession } = useAppStore();
  const [prompt, setPrompt] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const activeSession = activeSessionId ? sessions[activeSessionId] : null;
  const isRunning = activeSession?.status === 'running';

  // 自动调整高度
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [prompt]);

  const handleSend = async () => {
    if (!prompt.trim()) return;

    if (activeSessionId && activeSession) {
      // 继续现有会话
      sendEvent({
        type: 'session.continue',
        payload: {
          sessionId: activeSessionId,
          prompt: prompt.trim(),
        },
      });
      setPrompt('');
    } else {
      // 没有活动会话，显示新建视图
      setShowNewSession(true);
    }
  };

  const handleStop = () => {
    if (activeSessionId) {
      sendEvent({
        type: 'session.stop',
        payload: { sessionId: activeSessionId },
      });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (isRunning) {
        handleStop();
      } else {
        handleSend();
      }
    }
  };

  return (
    <div className="border-t border-[var(--border)] p-4 bg-[var(--bg-secondary)]">
      <div className="flex flex-col gap-2">
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            isRunning
              ? 'Press Enter to stop...'
              : activeSessionId
              ? 'Continue the conversation...'
              : 'Start a new session...'
          }
          rows={1}
          disabled={isRunning}
          className="w-full bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--accent)] resize-none min-h-[40px] max-h-[200px] disabled:opacity-50"
        />

        <div className="flex items-center gap-2">
          <div className="flex-1" />

          {isRunning ? (
            <button
              onClick={handleStop}
              className="px-4 py-1.5 rounded-lg text-sm bg-red-500 hover:bg-red-600 transition-colors"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!prompt.trim()}
              className="px-4 py-1.5 rounded-lg text-sm bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Send
            </button>
          )}
        </div>
      </div>

      <div className="text-xs text-[var(--text-muted)] mt-2">
        {isRunning
          ? 'Session is running. Press Enter or click Stop to abort.'
          : 'Press Enter to send, Shift+Enter for new line'}
      </div>
    </div>
  );
}

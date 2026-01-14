import { useState, useRef, useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';
import { sendEvent } from '../hooks/useIPC';
import { AVAILABLE_MODELS } from '../types';
import type { ModelId } from '../types';

export function PromptInput() {
  const { activeSessionId, sessions, setShowNewSession, selectedModel, setSelectedModel } = useAppStore();
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
          model: selectedModel,
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
          {/* Inline Model Picker */}
          <ModelPicker
            value={selectedModel}
            onChange={setSelectedModel}
            disabled={isRunning}
          />

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

// Inline Model Picker 组件
function ModelPicker({
  value,
  onChange,
  disabled,
}: {
  value: ModelId;
  onChange: (m: ModelId) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const model = AVAILABLE_MODELS.find((m) => m.id === value);

  return (
    <div className="relative">
      <button
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        className="px-3 py-1.5 rounded-lg text-xs bg-[var(--bg-tertiary)] hover:bg-[var(--bg-primary)] border border-[var(--border)] flex items-center gap-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <span className="text-[var(--text-secondary)]">{model?.displayName}</span>
        <ChevronDownIcon />
      </button>
      {open && (
        <>
          {/* 点击外部关闭 */}
          <div
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
          />
          <div className="absolute bottom-full mb-1 left-0 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg shadow-lg py-1 min-w-[180px] z-20">
            {AVAILABLE_MODELS.map((m) => (
              <button
                key={m.id}
                onClick={() => {
                  onChange(m.id);
                  setOpen(false);
                }}
                className={`w-full px-3 py-2 text-left text-sm hover:bg-[var(--bg-tertiary)] transition-colors ${
                  m.id === value ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'
                }`}
              >
                {m.displayName}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// 下拉箭头图标
function ChevronDownIcon() {
  return (
    <svg
      className="w-3 h-3 text-[var(--text-muted)]"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  );
}

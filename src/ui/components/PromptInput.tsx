import { useState, useRef, useEffect } from 'react';
import { Paperclip, Plus, ArrowUp, Square } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { sendEvent } from '../hooks/useIPC';
import type { Attachment } from '../types';
import { AttachmentChips } from './AttachmentChips';
import { ProviderPicker } from './ProviderPicker';
import { loadPreferredProvider, savePreferredProvider } from '../utils/provider';

export function PromptInput() {
  const { activeSessionId, sessions, setShowNewSession } = useAppStore();
  const [prompt, setPrompt] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [provider, setProvider] = useState(loadPreferredProvider());
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const activeSession = activeSessionId ? sessions[activeSessionId] : null;
  const isRunning = activeSession?.status === 'running';

  useEffect(() => {
    if (activeSession?.provider) {
      setProvider(activeSession.provider);
      savePreferredProvider(activeSession.provider);
    }
  }, [activeSessionId, activeSession?.provider]);

  // 自动调整高度
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [prompt]);

  const handleSend = async () => {
    if (!prompt.trim()) return;
    setMenuOpen(false);

    if (activeSessionId && activeSession) {
      // 继续现有会话
      sendEvent({
        type: 'session.continue',
        payload: {
          sessionId: activeSessionId,
          prompt: prompt.trim(),
          attachments: attachments.length > 0 ? attachments : undefined,
          provider,
        },
      });
      setPrompt('');
      setAttachments([]);
    } else {
      // 没有活动会话，显示新建视图
      setShowNewSession(true);
    }
  };

  const handleStop = () => {
    setMenuOpen(false);
    if (activeSessionId) {
      sendEvent({
        type: 'session.stop',
        payload: { sessionId: activeSessionId },
      });
    }
  };

  const handleAddAttachments = async () => {
    if (isRunning) return;
    const selected = await window.electron.selectAttachments();
    if (!selected || selected.length === 0) return;

    setAttachments((prev) => {
      const existingPaths = new Set(prev.map((a) => a.path));
      const next = [...prev];
      for (const a of selected) {
        if (!existingPaths.has(a.path)) {
          next.push(a);
        }
      }
      return next;
    });
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
    <div className="p-4 bg-transparent">
      <div className="max-w-4xl mx-auto">
        <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-3xl shadow-sm">
          {attachments.length > 0 && (
            <div className="px-5 pt-4">
              <AttachmentChips
                attachments={attachments}
                onRemove={(id) =>
                  setAttachments((prev) => prev.filter((a) => a.id !== id))
                }
              />
            </div>
          )}

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
            className="w-full bg-transparent px-5 pt-4 pb-3 text-[15px] outline-none resize-none min-h-[56px] max-h-[200px] disabled:opacity-50"
          />

          <div className="flex items-center gap-2 px-4 pb-4">
            <ProviderPicker
              value={provider}
              onChange={(next) => {
                setProvider(next);
                savePreferredProvider(next);
              }}
              disabled={isRunning}
            />

            <div className="relative">
              <button
                onClick={() => setMenuOpen((v) => !v)}
                disabled={isRunning}
                className="p-2 rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title="Add"
                aria-label="Add"
              >
                <Plus className="w-5 h-5" />
              </button>

              {menuOpen && !isRunning && (
                <>
                  <div
                    className="fixed inset-0 z-20"
                    onClick={() => setMenuOpen(false)}
                  />
                  <div className="absolute bottom-full mb-2 left-0 z-30 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl shadow-lg p-1 min-w-[220px]">
                    <button
                      onClick={async () => {
                        setMenuOpen(false);
                        await handleAddAttachments();
                      }}
                      className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors text-sm text-[var(--text-primary)]"
                    >
                      <Paperclip className="w-4 h-4" />
                      <span>Add files or photos</span>
                    </button>
                  </div>
                </>
              )}
            </div>

            <div className="flex-1" />

            {isRunning ? (
              <button
                onClick={handleStop}
                className="w-11 h-11 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)] hover:bg-[var(--bg-tertiary)] transition-colors flex items-center justify-center text-[var(--text-primary)]"
                title="Stop"
                aria-label="Stop"
              >
                <Square className="w-4 h-4" fill="currentColor" />
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!prompt.trim()}
                className="w-10 h-10 rounded-full flex items-center justify-center transition-colors disabled:cursor-not-allowed"
                style={{
                  backgroundColor: !prompt.trim() ? '#848588' : '#000000',
                  color: '#FFFFFF'
                }}
                title="Send"
                aria-label="Send"
              >
                <ArrowUp className="w-5 h-5" />
              </button>
            )}
          </div>
        </div>

        <div className="text-xs text-[var(--text-muted)] mt-2 px-1">
          {isRunning
            ? 'Session is running. Press Enter or click Stop to abort.'
            : 'Press Enter to send, Shift+Enter for new line'}
        </div>
      </div>
    </div>
  );
}

